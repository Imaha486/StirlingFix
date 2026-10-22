s=open('/home/claude/work/viewer.src.html').read()
j=open('/home/claude/work/hlp.js').read()
assert '</script' not in j
s=s.replace('/*HLPJS*/',j)
open('/home/claude/work/HlpViewer.html','w').write(s)
