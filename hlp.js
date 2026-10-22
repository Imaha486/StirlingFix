// WinHelp (.hlp) parser — shared by HlpViewer.html and node tests
"use strict";
const HLP = (function(){

function sjis(){ try { return new TextDecoder('shift_jis'); } catch(e){ return new TextDecoder('latin1'); } }

class R { // little-endian reader
  constructor(u8, pos){ this.b=u8; this.p=pos||0; this.dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength); }
  u8(){ return this.b[this.p++]; }
  i8(){ const v=this.dv.getInt8(this.p); this.p++; return v; }
  u16(){ const v=this.dv.getUint16(this.p,true); this.p+=2; return v; }
  i16(){ const v=this.dv.getInt16(this.p,true); this.p+=2; return v; }
  u32(){ const v=this.dv.getUint32(this.p,true); this.p+=4; return v; }
  i32(){ const v=this.dv.getInt32(this.p,true); this.p+=4; return v; }
  cstr(){ let e=this.p; while(e<this.b.length && this.b[e]) e++; const s=this.b.subarray(this.p,e); this.p=e+1; return s; }
  // compressed numbers (helpdeco semantics)
  cword(){ const b=this.b[this.p]; if(b&1){ return this.u16()>>>1; } this.p++; return b>>>1; }
  cint(){ const b=this.b[this.p]; if(b&1){ return (this.u16()>>>1)-0x4000; } this.p++; return (b>>>1)-0x40; }
  clong(){ const w=this.dv.getUint16(this.p,true); if(w&1){ return (this.u32()>>>1)-0x40000000; } this.p+=2; return (w>>>1)-0x4000; }
  culong(){ const w=this.dv.getUint16(this.p,true); if(w&1){ return this.u32()>>>1; } this.p+=2; return w>>>1; }
}

function lz77(src, start, end, maxOut){
  const out=new Uint8Array(maxOut||Math.max(16,(end-start)*8));
  let o=0, i=start, buf=out;
  function grow(n){ if(o+n>buf.length){ const nb=new Uint8Array(Math.max(buf.length*2,o+n+16)); nb.set(buf.subarray(0,o)); buf=nb; } }
  while(i<end){
    const flags=src[i++];
    for(let bit=0; bit<8 && i<end; bit++){
      if(flags & (1<<bit)){
        if(i+1>=end){ i=end; break; }
        const w=src[i] | (src[i+1]<<8); i+=2;
        const len=(w>>>12)+3, dist=(w&0xFFF)+1;
        grow(len);
        for(let k=0;k<len;k++){ const s=o-dist; buf[o]= s>=0? buf[s]:0; o++; }
      } else { grow(1); buf[o++]=src[i++]; }
    }
  }
  return buf.subarray(0,o);
}

// WinHelp context-string hash
function ctxHash(str){
  let h=0;
  for(let i=0;i<str.length;i++){
    let c=str.charCodeAt(i)&0xFF, t;
    if(c>=0x61 && c<=0x7A) c-=0x20;
    if(c===0x30) t=10; else if(c===0x21) t=11; else if(c===0x2E) t=12; else if(c===0x5F) t=13;
    else { t=c-48; if(t>127) t-=256; }
    h=(Math.imul(h,43)+t)|0;
  }
  return h>>>0;
}

class HelpFile {
  constructor(buf){
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dec = sjis();
    this.warn=[];
    const r=new R(this.u8,0);
    const magic=r.u32();
    if(magic!==0x00035F3F) throw new Error('WinHelp (.hlp) ファイルではありません (magic='+magic.toString(16)+')');
    this.dirStart=r.u32();
    this.files=this.readDirectory();
    this.readSystem();
    this.readFonts();
    this.readPhrases();
    this.readContext();
    this.readCtxomap();
    this.readKeywords();
    this.readTopics();
  }
  s(u8){ return this.dec.decode(u8); }
  file(name){ const o=this.files[name]; if(o===undefined) return null;
    const r=new R(this.u8,o); const reserved=r.u32(); const used=r.u32(); r.u8();
    return this.u8.subarray(o+9, o+9+used); }
  // generic B+ tree walk; leafEntry(r) reads one entry, indexEntry(r) skips key in index page
  btree(data, leafEntry, skipKey){
    const r=new R(data,0);
    const magic=r.u16(); if(magic!==0x293B) throw new Error('btree magic');
    r.u16(); const pageSize=r.u16(); r.p+=16; r.u16(); r.u16();
    const root=r.u16(); r.u16(); const totalPages=r.u16(); const nLevels=r.u16(); r.u32();
    const base=r.p; // 38
    let page=root;
    for(let lv=1; lv<nLevels; lv++){
      const pr=new R(data, base+page*pageSize); pr.u16(); pr.u16(); page=pr.u16();
    }
    const out=[]; let guard=0;
    while(page!==0xFFFF && guard++<=totalPages){
      const pr=new R(data, base+page*pageSize);
      pr.u16(); const n=pr.u16(); pr.u16(); const next=pr.u16();
      for(let k=0;k<n;k++) out.push(leafEntry(pr));
      page=next;
    }
    return out;
  }
  readDirectory(){
    const o=this.dirStart; const data=this.u8.subarray(o+9);
    const files={};
    this.btree(data, r=>{ const n=this.dec.decode(r.cstr()); files[n]=r.u32(); return 0; });
    return files;
  }
  readSystem(){
    const d=this.file('|SYSTEM'); const r=new R(d,0);
    r.u16(); this.minor=r.u16(); this.major=r.u16(); this.genDate=r.u32(); this.flags=r.u16();
    this.title=''; this.contentsOffset=0; this.windows=[]; this.config=[];
    if(this.minor<=16){ this.title=this.s(r.cstr()); this.compressed=false; this.blockSize=2048; }
    else {
      this.compressed = this.flags===4 || this.flags===8;
      this.blockSize = this.flags===8 ? 2048 : 4096;
      while(r.p+4<=d.length){
        const type=r.u16(), size=r.u16(); const p=r.p; const rec=d.subarray(p,p+size);
        if(type===1) this.title=this.s(rec.subarray(0, rec.indexOf(0)<0?rec.length:rec.indexOf(0)));
        else if(type===2) this.copyright=this.s(rec.subarray(0, rec.indexOf(0)<0?rec.length:rec.indexOf(0)));
        else if(type===3) this.contentsOffset=new R(rec,0).u32();
        else if(type===4) this.config.push(this.s(rec.subarray(0, rec.indexOf(0)<0?rec.length:rec.indexOf(0))));
        else if(type===6) this.windows.push(parseWin(rec, this));
        else if(type===9) this.lcid=new R(rec,0).u16();
        else if(type===11) this.charset=rec[0];
        r.p=p+size;
      }
    }
    if(this.minor<=16) this.decSize = this.blockSize-12; else this.decSize = this.compressed? 0x4000 : this.blockSize-12;
  }
  readFonts(){
    this.fontNames=[]; this.fonts=[];
    const d=this.file('|FONT'); if(!d) return;
    const r=new R(d,0);
    const nNames=r.u16(), nDesc=r.u16(), namesOff=r.u16(), descOff=r.u16();
    const nameLen = nNames? Math.floor((descOff-namesOff)/nNames) : 32;
    for(let i=0;i<nNames;i++){ const s=d.subarray(namesOff+i*nameLen, namesOff+(i+1)*nameLen); const z=s.indexOf(0); this.fontNames.push(this.s(z<0?s:s.subarray(0,z))); }
    // old style (11 byte) descriptors; newer MVB style detected by size
    let dsz=11;
    if(namesOff>=16){ // WinHelp4 header with styles
      const r2=new R(d,8); const nStyles=r2.u16(), styleOff=r2.u16();
      if(nDesc){ const end = styleOff>descOff ? styleOff : d.length; const est=Math.floor((end-descOff)/nDesc); if(est===11||est===48||est===42) dsz=est; }
    }
    for(let i=0;i<nDesc;i++){
      const q=new R(d, descOff+i*dsz);
      if(dsz===11){
        const attr=q.u8(), half=q.u8(), fam=q.u8(), face=q.u16();
        const fg=[q.u8(),q.u8(),q.u8()], bg=[q.u8(),q.u8(),q.u8()];
        this.fonts.push({bold:!!(attr&1), italic:!!(attr&2), underline:!!(attr&4), strike:!!(attr&8), dunder:!!(attr&16), smallcaps:!!(attr&32),
          size:half/2, face:this.fontNames[face]||'', fg, bg, family:fam});
      } else {
        // MVB new font: FontName(2) FGRGB(3) BGRGB(3) unknown(5) Height(4) ... Weight(4)... Italic Underline Strike...
        q.u8(); const face=q.u16(); const fg=[q.u8(),q.u8(),q.u8()], bg=[q.u8(),q.u8(),q.u8()];
        q.p+=5; const height=q.i32(); q.p+=12; const weight=q.i32(); q.p+=3; const italic=q.u8(), underline=q.u8(), strike=q.u8();
        this.fonts.push({bold:weight>500, italic:!!italic, underline:!!underline, strike:!!strike, size:Math.abs(height)?Math.abs(height)*0.75:10, face:this.fontNames[face]||'', fg, bg});
      }
    }
  }
  readPhrases(){
    this.phrases=null; this.hall=false;
    const pi=this.file('|PhrIndex'), pm=this.file('|PhrImage');
    if(pi && pm){
      this.hall=true;
      const r=new R(pi,0);
      r.u32(); const entries=r.u32(); const csize=r.u32(); const imgSize=r.u32(); const imgCSize=r.u32(); r.u32();
      const bw=r.u16(); r.u16(); const bits=bw&0x0F;
      let val=0, mask=0;
      const getbit=()=>{ mask=(mask<<1)>>>0; if(!mask){ val=r.u32(); mask=1; } return (val&mask)!==0; };
      const offs=[0];
      for(let i=0;i<entries;i++){
        let n=1; while(getbit()) n+=1<<bits;
        if(getbit()) n+=1; if(bits>1 && getbit()) n+=2; if(bits>2 && getbit()) n+=4; if(bits>3 && getbit()) n+=8; if(bits>4 && getbit()) n+=16;
        offs.push(offs[i]+n);
      }
      const img = (imgSize===imgCSize) ? pm.subarray(0,imgSize) : lz77(pm,0,pm.length,imgSize);
      this.phrases=[]; for(let i=0;i<entries;i++) this.phrases.push(img.subarray(offs[i],offs[i+1]));
      return;
    }
    const d=this.file('|Phrases'); if(!d) return;
    const r=new R(d,0);
    const n=r.u16(); const hundred=r.u16();
    let offs=[], text;
    if(this.minor<=16){
      for(let i=0;i<=n;i++) offs.push(r.u16());
      const base=4; text=d; offs=offs.map(x=>x+base);
      this.phrases=[]; for(let i=0;i<n;i++) this.phrases.push(text.subarray(offs[i],offs[i+1]));
    } else {
      const dsize=r.u32();
      for(let i=0;i<=n;i++) offs.push(r.u16());
      const start=r.p;
      const plain = lz77(d, start, d.length, dsize);
      const b0=offs[0];
      this.phrases=[]; for(let i=0;i<n;i++) this.phrases.push(plain.subarray(offs[i]-b0, offs[i+1]-b0));
    }
  }
  readContext(){
    this.ctx=new Map(); // hash -> topic offset
    const d=this.file('|CONTEXT'); if(!d) return;
    this.btree(d, r=>{ const h=r.u32(), o=r.u32(); this.ctx.set(h,o); return 0; });
  }
  readCtxomap(){
    this.ctxomap=new Map();
    const d=this.file('|CTXOMAP'); if(!d) return;
    const r=new R(d,0); const n=r.u16();
    for(let i=0;i<n && r.p+8<=d.length;i++){ const id=r.u32(), off=r.u32(); this.ctxomap.set(id,off); }
  }
  readKeywords(){
    this.keywords=[];
    const bt=this.file('|KWBTREE'), kd=this.file('|KWDATA'); if(!bt||!kd) return;
    const kr=new R(kd,0);
    this.btree(bt, r=>{ const k=this.s(r.cstr()); const cnt=r.u16(); const off=r.u32();
      const tops=[]; for(let i=0;i<cnt;i++){ kr.p=off+i*4; if(kr.p+4<=kd.length) tops.push(kr.u32()); }
      this.keywords.push({key:k, offsets:tops}); return 0; });
  }
  // ---------- topic file ----------
  topicBlocks(){
    const d=this.file('|TOPIC'); const bs=this.blockSize; const blocks=[];
    for(let p=0, n=0; p<d.length; p+=bs, n++){
      const hdr=new R(d,p); const lastLink=hdr.i32(), firstLink=hdr.i32(), lastHdr=hdr.i32();
      const end=Math.min(p+bs, d.length);
      const data = this.compressed ? lz77(d, p+12, end, this.decSize) : d.subarray(p+12, end);
      blocks.push({firstLink, lastLink, data});
    }
    return blocks;
  }
  readTopics(){
    const blocks=this.blocks=this.topicBlocks();
    const DS=this.decSize;
    // stream reader across blocks. TopicPos: block = pos / DS, off = pos % DS - 12
    const self=this;
    function reader(pos){
      let b=Math.floor(pos/DS), o=(pos%DS)-12;
      return {
        read(n){ const out=new Uint8Array(n); let k=0;
          while(k<n){ if(b>=blocks.length) throw new Error('topic read overflow');
            const bd=blocks[b].data; const take=Math.min(n-k, bd.length-o);
            if(take<=0){ b++; o=0; continue; }
            out.set(bd.subarray(o,o+take),k); k+=take; o+=take; }
          return out; },
        get block(){ return b; }
      };
    }
    this.topics=[]; this.linkOffsets=[]; // linkOffsets: [topicOffset, topicIndex]
    let pos = blocks.length? blocks[0].firstLink : -1;
    if(this.minor<=16){ this.warn.push('WinHelp 3.0 形式は部分対応です'); }
    let cur=null, guard=0;
    let curBlock=-1, charCount=0;
    const total = blocks.length*DS;
    while(pos>=0 && pos<total && guard++<200000){
      const rd=reader(pos);
      const startBlock=Math.floor(pos/DS);
      const hb=rd.read(21); const h=new R(hb,0);
      const blockSize=h.i32(), dataLen2=h.i32(), prev=h.i32(), next=h.i32(), dataLen1=h.i32(), type=h.u8();
      if(blockSize<21 || dataLen1<21){ this.warn.push('不正な TOPICLINK @'+pos); break; }
      const ld1=rd.read(dataLen1-21);
      const len2raw=blockSize-dataLen1;
      const ld2raw=rd.read(Math.max(0,len2raw));
      let ld2=ld2raw;
      if(dataLen2>len2raw) ld2=this.dephrase(ld2raw, dataLen2);
      if(startBlock!==curBlock){ curBlock=startBlock; charCount=0; }
      const topicOffset = curBlock*0x8000 + charCount;
      if(type===2){
        const r=new R(ld1,0);
        const hd={};
        if(this.minor>16){ hd.blockSize=r.i32(); hd.browseBck=r.i32(); hd.browseFor=r.i32(); hd.topicNum=r.i32(); hd.nonScroll=r.i32(); hd.scroll=r.i32(); hd.nextTopic=r.i32(); }
        let z=ld2.indexOf(0); const title=this.s(z<0?ld2:ld2.subarray(0,z));
        const macros=[]; if(z>=0){ let q=z+1; while(q<ld2.length){ let e=ld2.indexOf(0,q); if(e<0)e=ld2.length; if(e>q) macros.push(this.s(ld2.subarray(q,e))); q=e+1; } }
        cur={index:this.topics.length, title, macros, pos, offset:topicOffset, hdr:hd, records:[]};
        this.topics.push(cur);
        this.linkOffsets.push([topicOffset, cur.index]);
      } else if(type===0x20 || type===0x23 || type===1){
        if(cur){
          cur.records.push({type, ld1, ld2, offset:topicOffset, nonScroll: cur.hdr.scroll!==undefined && cur.hdr.scroll!==-1 && pos < cur.hdr.scroll});
          this.linkOffsets.push([topicOffset, cur.index]);
        }
        charCount += dataLen2;
      }
      if(this.minor<=16){ if(next<=0) break; pos = pos + next; }
      else { if(next<=0 || next===pos) break; pos=next; }
    }
    this.linkOffsets.sort((a,b)=>a[0]-b[0]);
  }
  dephrase(src, outLen){
    const out=new Uint8Array(outLen+64); let o=0;
    const ph=this.phrases||[];
    const put=(arr)=>{ for(let k=0;k<arr.length && o<out.length;k++) out[o++]=arr[k]; };
    let i=0;
    if(this.hall){
      while(i<src.length && o<outLen){
        const c=src[i++];
        if((c&1)===0){ put(ph[c>>>1]||[]); }
        else if((c&3)===1){ const idx=128+(c>>>2)*256+src[i++]; put(ph[idx]||[]); }
        else if((c&7)===3){ const n=(c>>>3)+1; put(src.subarray(i,i+n)); i+=n; }
        else if((c&15)===7){ const n=(c>>>4)+1; for(let k=0;k<n;k++) out[o++]=0x20; }
        else { const n=(c>>>4)+1; for(let k=0;k<n;k++) out[o++]=0; }
      }
    } else {
      while(i<src.length && o<outLen){
        const c=src[i++];
        if(c>0 && c<0x10 && i<src.length){
          const code=(c-1)*256+src[i++]; put(ph[code>>>1]||[]); if(code&1) out[o++]=0x20;
        } else out[o++]=c;
      }
    }
    return out.subarray(0,Math.min(o,outLen));
  }
  topicByOffset(off){
    const a=this.linkOffsets; if(!a.length) return null;
    let lo=0, hi=a.length-1, best=0;
    while(lo<=hi){ const m=(lo+hi)>>1; if(a[m][0]<=off){ best=m; lo=m+1; } else hi=m-1; }
    return this.topics[a[best][1]];
  }
  topicByHash(h){ const o=this.ctx.get(h>>>0); return o===undefined? null : this.topicByOffset(o); }
  topicByContext(name){ return this.topicByHash(ctxHash(name)); }
  topicByMapId(id){ const o=this.ctxomap.get(id>>>0); return o===undefined? null: this.topicByOffset(o); }
  contentsTopic(){ return this.topicByOffset(this.contentsOffset||0) || this.topics[0]; }

  // ---------- render topic to HTML ----------
  render(topic, opt){
    opt=opt||{};
    const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let html='';
    let nsHtml='', inNs=true;
    for(const rec of topic.records){
      let h='';
      try { h=this.renderRecord(rec, esc); } catch(e){ h='<p class="err">[描画エラー: '+esc(String(e.message))+']</p>'; }
      if(rec.nonScroll) nsHtml+=h; else html+=h;
    }
    return {nonScroll:nsHtml, body:html};
  }
  fontStyle(n){
    const f=this.fonts[n]; if(!f) return '';
    let st=[];
    if(f.face) st.push("font-family:'"+f.face.replace(/'/g,'')+"',var(--basefont)");
    if(f.size) st.push('font-size:'+(f.size)+'pt');
    if(f.bold) st.push('font-weight:bold');
    if(f.italic) st.push('font-style:italic');
    const deco=[]; if(f.underline||f.dunder) deco.push('underline'); if(f.strike) deco.push('line-through');
    if(deco.length) st.push('text-decoration:'+deco.join(' '));
    if(f.smallcaps) st.push('font-variant:small-caps');
    if(f.fg && (f.fg[0]||f.fg[1]||f.fg[2])) st.push('color:rgb('+f.fg.join(',')+')');
    return st.join(';');
  }
  renderRecord(rec, esc){
    const r=new R(rec.ld1,0); const t=rec.ld2;
    let tp=0;
    const nextStr=()=>{ let e=t.indexOf(0,tp); if(e<0) e=t.length; const s=t.subarray(tp,e); tp=e+1; return s; };
    let out='';
    r.clong(); // topic size
    r.cword(); // topic length
    let table=null;
    if(rec.type===0x23){
      const cols=r.u8(), ttype=r.u8();
      if(ttype===0||ttype===2) r.i16();
      const colw=[]; for(let c=0;c<cols;c++){ const gap=r.i16(), w=r.i16(); colw.push(w); }
      table={cols, colw, cells:[]};
    }
    let html='';
    let guard=0;
    while(r.p<rec.ld1.length && guard++<10000){
      let col=0;
      if(table){ col=r.i16(); if(col===-1) break; r.i16(); r.u8(); }
      // paragraph info
      r.u8(); r.u8(); r.u16();
      const bits=r.u16();
      const para={};
      if(bits&0x0001) r.clong();
      if(bits&0x0002) para.above=r.cint();
      if(bits&0x0004) para.below=r.cint();
      if(bits&0x0008) para.lines=r.cint();
      if(bits&0x0010) para.left=r.cint();
      if(bits&0x0020) para.right=r.cint();
      if(bits&0x0040) para.first=r.cint();
      if(bits&0x0100){ para.border=r.u8(); r.i16(); }
      if(bits&0x0200){ const n=r.cint(); para.tabs=[]; for(let k=0;k<n;k++){ const ts=r.cword(); if(ts&0x4000) r.cword(); para.tabs.push(ts&0x3FFF); } }
      para.align = (bits&0x0800)?'center':(bits&0x0400)?'right':'left';
      const pstyle=()=>{ const s=[]; const tw=v=>(v*10/15).toFixed(1)+'px';
        if(para.left) s.push('margin-left:'+tw(para.left)); if(para.right) s.push('margin-right:'+tw(para.right));
        if(para.first) s.push('text-indent:'+tw(para.first)); if(para.above) s.push('margin-top:'+tw(para.above));
        if(para.below) s.push('margin-bottom:'+tw(para.below)); if(para.align!=='left') s.push('text-align:'+para.align);
        if(para.border) s.push('border:1px solid currentColor;padding:2px 4px');
        if(para.tabs && para.tabs.length) s.push('tab-size:'+Math.max(8,Math.round(para.tabs[0]*10/15))+'px');
        return s.join(';'); };
      let cell=''; let line=''; let spanOpen=false; let linkOpen=false; let hasText=false;
      const closeSpan=()=>{ if(spanOpen){ line+='</span>'; spanOpen=false; } };
      const flushPara=()=>{ closeSpan(); if(linkOpen){ line+='</a>'; linkOpen=false; }
        cell+='<p style="'+pstyle()+'">'+line+(hasText?'':'&nbsp;')+'</p>'; line=''; hasText=false; };
      let curFont=-1;
      const openFont=(n)=>{ closeSpan(); curFont=n; const st=this.fontStyle(n); if(st){ line+='<span style="'+st+'">'; spanOpen=true; } };
      let g2=0;
      for(;;){
        if(g2++>20000) break;
        const s=nextStr(); if(s.length){ line+=esc(this.s(s)); hasText=true; }
        if(r.p>=rec.ld1.length) break;
        const cmd=r.u8();
        if(cmd===0xFF) break;
        switch(cmd){
          case 0x20: r.i32(); break;
          case 0x21: r.i16(); break;
          case 0x80: { const f=r.u16(); if(linkOpen){ closeSpan(); curFont=f; } else openFont(f); break; }
          case 0x81: line+='<br>'; hasText=true; break;
          case 0x82: flushPara(); if(curFont>=0) openFont(curFont); break;
          case 0x83: line+='\t'; hasText=true; break;
          case 0x86: case 0x87: case 0x88: {
            const kind=r.u8(); const size=r.culong(); let after=r.p+size;
            if(kind===0x22){ r.cword(); after=r.p+size; }
            let picnum=-1, ptype=-1;
            if(kind===0x03||kind===0x22){ ptype=r.u16(); picnum=r.u16(); }
            else if(kind===0x05){ r.u16(); r.u16(); r.u16(); const nm=this.s(r.cstr()); line+='<span class="ewc">['+esc(nm)+']</span>'; }
            r.p=after;
            if(picnum>=0){ line+=this.picHtml(picnum, cmd); hasText=true; }
            break; }
          case 0x89: if(linkOpen){ closeSpan(); line+='</a>'; linkOpen=false; } if(curFont>=0) openFont(curFont); break;
          case 0x8B: line+='&nbsp;'; hasText=true; break;
          case 0x8C: line+='&#8209;'; break;
          case 0xC8: case 0xCC: { const len=r.i16(); const m=this.s(rec.ld1.subarray(r.p, r.p+len).filter(x=>x)); r.p+=len;
            closeSpan(); line+='<a class="macro" data-macro="'+esc(m).replace(/"/g,'&quot;')+'" href="#">'; linkOpen=true; if(curFont>=0 && cmd===0xC8) openFont(curFont); break; }
          case 0xE0: case 0xE1: case 0xE2: case 0xE3: case 0xE6: case 0xE7: {
            const v=r.u32(); const popup=(cmd===0xE0||cmd===0xE2||cmd===0xE6);
            const attr = (cmd<=0xE1) ? 'data-off="'+v+'"' : 'data-hash="'+v+'"';
            closeSpan(); line+='<a class="'+(popup?'popup':'jump')+'" '+attr+' href="#">'; linkOpen=true; if(curFont>=0) openFont(curFont); break; }
          case 0xEA: case 0xEB: case 0xEE: case 0xEF: {
            const len=r.i16(); const st=r.p; const typ=r.u8(); const h=r.u32();
            let file='', win='';
            if(typ===1){ r.u8(); } else if(typ===4||typ===6){ const a=this.s(r.cstr()); if(typ===6){ win=a; if(r.p<st+len) file=this.s(r.cstr()); } else file=a; }
            r.p=st+len;
            const popup=(cmd===0xEA||cmd===0xEE);
            closeSpan(); line+='<a class="'+(popup?'popup':'jump')+(file?' ext':'')+'" data-hash="'+h+'"'+(file?' data-file="'+esc(file)+'"':'')+' href="#">'; linkOpen=true; if(curFont>=0) openFont(curFont); break; }
          default:
            this.warn.push('未知のコマンド 0x'+cmd.toString(16)); r.p=rec.ld1.length; break;
        }
      }
      if(line!=='') flushPara(); else closeSpan();
      if(table){ table.cells.push({col, html:cell}); }
      else html+=cell;
      if(!table) break;
    }
    if(table){
      let t='<table class="hlptable"><tr>'; let lastCol=-1;
      for(const c of table.cells){ if(c.col<=lastCol){ t+='</tr><tr>'; } lastCol=c.col; t+='<td>'+c.html+'</td>'; }
      t+='</tr></table>'; html+=t;
    }
    return html;
  }
  picHtml(n, cmd){
    const cls = cmd===0x87?'bml':cmd===0x88?'bmr':'bmc';
    let url=null; try{ url=this.bitmapURL(n); }catch(e){}
    if(url) return '<img class="'+cls+'" src="'+url+'" alt="bm'+n+'">';
    return '<span class="pic '+cls+'">[図 bm'+n+']</span>';
  }
  // ---- bitmap |bmN (SHG/MRB): returns data URL (BMP) for first DIB/DDB picture ----
  bitmapURL(n){
    this._bm=this._bm||{}; if(n in this._bm) return this._bm[n];
    let d=this.file('|bm'+n) || this.file('bm'+n); if(!d){ this._bm[n]=null; return null; }
    const r=new R(d,0); const magic=r.u16(); const cnt=r.u16(); const off0=r.u32();
    const q=new R(d,off0);
    const ptype=q.u8(), pack=q.u8();
    let url=null;
    if(ptype===5||ptype===6){
      const xdpi=q.culong(), ydpi=q.culong(), planes=q.cword(), bitcount=q.cword(), width=q.culong(), height=q.culong();
      const colors=q.culong(), important=q.culong(), csize=q.culong(), hsize=q.culong(); const coff=q.u32(), hoff=q.u32();
      let pal=[]; if(ptype===6){ const nc = colors || (bitcount<=8 ? (1<<bitcount):0); for(let i=0;i<nc;i++){ pal.push(q.u32()); } }
      else if(bitcount===1){ pal=[0x000000,0xFFFFFF]; }
      const raw=d.subarray(off0+coff, off0+coff+csize);
      let px;
      if(pack===0) px=raw; else if(pack===1) px=unrle(raw); else if(pack===2) px=lz77(raw,0,raw.length); else if(pack===3) px=unrle(lz77(raw,0,raw.length)); else return (this._bm[n]=null);
      url=makeBMP(width,height,bitcount,pal,px, ptype===5);
    }
    this._bm[n]=url; return url;
  }
}
function parseWin(rec, hf){
  const z=(a)=>{ const i=a.indexOf(0); return hf.s(i<0?a:a.subarray(0,i)); };
  const w={flags:rec[0]|(rec[1]<<8), type:z(rec.subarray(2,12)), name:z(rec.subarray(12,21)), caption:z(rec.subarray(21,72))};
  if(rec.length>=90){ w.rgb=[rec[82],rec[83],rec[84]]; w.rgbNsr=[rec[86],rec[87],rec[88]]; }
  return w;
}
function unrle(src){
  const out=[]; let i=0;
  while(i<src.length){ const c=src[i++]; if(c&0x80){ const n=c&0x7F; for(let k=0;k<n&&i<src.length;k++) out.push(src[i++]); } else { const v=src[i++]; for(let k=0;k<c;k++) out.push(v); } }
  return new Uint8Array(out);
}
function makeBMP(w,h,bpp,pal,px,ddb){
  // DDB rows are word-aligned and top-down; DIB rows are dword aligned bottom-up
  const stride=((w*bpp+31)>>>5)<<2;
  let rows=px;
  if(ddb){ const s2=((w*bpp+15)>>>4)<<1; const nb=new Uint8Array(stride*h); for(let y=0;y<h;y++){ nb.set(px.subarray(y*s2,y*s2+Math.min(s2,stride)), (h-1-y)*stride); } rows=nb; }
  const palBytes=pal.length*4; const off=54+palBytes; const size=off+stride*h;
  const b=new Uint8Array(size); const dv=new DataView(b.buffer);
  b[0]=0x42;b[1]=0x4D; dv.setUint32(2,size,true); dv.setUint32(10,off,true);
  dv.setUint32(14,40,true); dv.setInt32(18,w,true); dv.setInt32(22,h,true); dv.setUint16(26,1,true); dv.setUint16(28,bpp,true);
  dv.setUint32(34,stride*h,true); dv.setUint32(46,pal.length,true);
  pal.forEach((c,i)=>dv.setUint32(54+i*4,c,true));
  b.set(rows.subarray(0,Math.min(rows.length,stride*h)),off);
  let s=''; for(let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));
  return 'data:image/bmp;base64,'+btoa(s);
}
function parseCnt(u8){
  const text=sjis().decode(u8); const items=[]; let title='', base='';
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/\s+$/,''); if(!line) continue;
    if(line[0]===':'){ const m=line.match(/^:(\w+)\s*(.*)$/); if(m){ if(/^title$/i.test(m[1])) title=m[2]; if(/^base$/i.test(m[1])) base=m[2]; } continue; }
    const m=line.match(/^(\d+)\s*(.*)$/); if(!m) continue;
    const lv=+m[1]; let rest=m[2]; let ctx=null;
    const eq=rest.lastIndexOf('=');
    if(eq>=0){ ctx=rest.slice(eq+1).trim(); rest=rest.slice(0,eq); }
    let file=null; if(ctx){ const at=ctx.indexOf('@'); if(at>=0){ file=ctx.slice(at+1); ctx=ctx.slice(0,at);} const gt=ctx.indexOf('>'); if(gt>=0) ctx=ctx.slice(0,gt); }
    items.push({level:lv, text:rest.trim(), ctx, file});
  }
  return {title, base, items};
}
return {HelpFile, ctxHash, parseCnt, lz77};
})();
if(typeof module!=='undefined') module.exports=HLP;
