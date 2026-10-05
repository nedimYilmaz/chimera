// Chromium includes both cue endpoints when seeking exactly onto a beat boundary.
export function createCaptions(chapters, offset=0) {
  const clock=t=>`00:${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(3).padStart(6,'0')}`;
  const cues=[];
  for(const ch of chapters) ch.beats.forEach((beat,i)=>{
    const start=ch.start+beat.at-offset;
    const end=ch.start+(ch.beats[i+1]?.at??ch.end-ch.start)-offset-.001;
    if(end<=start || (cues.length && start<=cues.at(-1)[1])) throw Error('Caption beats must be disjoint and ordered');
    cues.push([start,end,beat.text]);
  });
  return 'WEBVTT\n\n'+cues.map(([a,b,s],i)=>`${i+1}\n${clock(a)} --> ${clock(b)} line:71%\n${s}\n`).join('\n');
}
