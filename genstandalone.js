const fs=require('fs');
const viewer=fs.readFileSync('HlpViewer.html','utf8');
function b64(path){ return fs.readFileSync(path).toString('base64'); }
const args=process.argv.slice(2); const hlp=args[0], cnt=args[1], out=args[2];
const name=hlp.split('/').pop(), cname=cnt?cnt.split('/').pop():'';
let emb='<script type="application/x-hlp" data-kind="hlp" data-name="'+name+'">'+b64(hlp)+'<\/script>';
if(cnt) emb+='<script type="application/x-hlp" data-kind="cnt" data-name="'+cname+'">'+b64(cnt)+'<\/script>';
const html=viewer.replace('<!--EMBED-->','<!--EMBED-->'+emb);
fs.writeFileSync(out,html);
console.log('wrote',out,(html.length/1024|0)+'KB');
