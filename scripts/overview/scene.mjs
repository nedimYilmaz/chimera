// A deterministic illustrated timeline, deliberately independent of product components.
export function createFilm(canvas, story, logo) {
  const c=canvas.getContext('2d', {alpha:false});
  const W=story.width,H=story.height; canvas.width=W;canvas.height=H;
  let light=false;
  const P={ink:'#14161a',panel:'#20242b',cream:'#f4f1ea',muted:'#b9bdca',lilac:'#9aa3f2',green:'#79c58c',amber:'#ddb780',rule:'#3d424c'};
  const clamp=x=>Math.max(0,Math.min(1,x));
  const ease=x=>{x=clamp(x);return x*x*(3-2*x);};
  const ramp=(t,a,d=1.2)=>ease((t-a)/d);
  function text(s,x,y,size=44,color=P.cream,weight=500,align='center') {
    c.font=`${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;c.fillStyle=color;c.textAlign=align;c.textBaseline='middle';
    s.split('\n').forEach((line,i)=>c.fillText(line,x,y+i*size*1.22));
  }
  function box(x,y,w,h,color=P.panel,stroke=P.rule,r=24) {
    c.beginPath();c.roundRect(x-w/2,y-h/2,w,h,r);c.fillStyle=color;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=2;c.stroke();}
  }
  function card(x,y,w,h,title,sub='',accent=P.lilac,alpha=1) {
    c.save();c.globalAlpha*=alpha;c.shadowColor='#00000040';c.shadowBlur=30;c.shadowOffsetY=12;box(x,y,w,h);c.shadowBlur=0;c.shadowOffsetY=0;
    c.fillStyle=accent;c.beginPath();c.roundRect(x-w/2+24,y-h/2+22,6,h-44,3);c.fill();
    const left=x-w/2+56,right=x+w/2-24,center=(left+right)/2,available=right-left;
    c.font='600 44px -apple-system, BlinkMacSystemFont, sans-serif';const size=Math.min(44,44*available/c.measureText(title).width);text(title,center,y-(sub?19:0),size,P.cream,600);if(sub){c.font='500 30px -apple-system, BlinkMacSystemFont, sans-serif';const subSize=Math.min(30,30*available/c.measureText(sub).width);text(sub,center,y+38,subSize,P.muted);}c.restore();
  }
  function line(x1,y1,x2,y2,p=1,color=P.lilac,bend=0,width=4) {
    // A sampled cubic makes path drawing and the travelling point share one curve.
    c.strokeStyle=color;c.lineWidth=width;c.lineCap='round';c.beginPath();
    for(let i=0;i<=Math.floor(clamp(p)*60);i++){const u=i/60,v=1-u;
      const x=v*v*v*x1+3*v*v*u*(x1+bend)+3*v*u*u*(x2-bend)+u*u*u*x2;
      const y=v*v*v*y1+3*v*v*u*y1+3*v*u*u*y2+u*u*u*y2;
      if(!i)c.moveTo(x,y);else c.lineTo(x,y);
    }c.stroke();
  }
  function dot(x,y,r=8,color=P.green){c.fillStyle=color;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();}
  function arrive(t,a,x,y,fromX,fromY,draw){const p=ramp(t,a);c.save();c.translate((fromX-x)*(1-p),(fromY-y)*(1-p));c.globalAlpha*=p;draw();c.restore();}
  function logoAt(x,y,size){c.drawImage(logo,x-size/2,y-size/2,size,size);}
  function ring(x,y,r,t,color=P.rule){c.save();c.strokeStyle=color;c.lineWidth=2;c.beginPath();c.ellipse(x,y,r,r*.55,Math.sin(t*.13)*.07,0,Math.PI*2);c.stroke();c.restore();}
  function caption(ch,t){
    const beat=ch.beats.filter(b=>t>=b.at).at(-1)??ch.beats[0];
    c.font='500 58px -apple-system, BlinkMacSystemFont, sans-serif';if(c.measureText(beat.text).width>1440)throw Error('Caption exceeds safe width: '+beat.text);
    text(beat.text,W/2,story.safeRegions.caption.centerY,58,light?P.ink:P.cream,500);
  }
  function diagramClip(intro=false){const region=story.safeRegions.diagram;c.save();c.beginPath();c.rect(intro?930:region.left,region.top,intro?590:region.right-region.left,region.bottom-region.top);c.clip();c.transform(1,0,0,.62,0,75);}
  function heading(ch,t){c.save();c.globalAlpha=ramp(t,.1,.85);text(ch.title,100,182,78,light?P.ink:P.cream,650,'left');c.restore();}
  function scene(ch,t) {
    const breath=Math.sin(t*.5)*5;
    if(ch.key==='assemble'||ch.key==='close') {
      const ending=ch.key==='close';
      c.save();c.globalAlpha=1;text(ch.title,110,290,104,P.cream,650,'left');if(!ending)text(story.openingDescriptor,115,485,58,P.muted,500,'left');else text('CHIMERA',115,555,38,P.lilac,650,'left');c.restore();
      diagramClip(true);
      const hubX=1225,hubY=515;
      ring(hubX,hubY,215,t);ring(hubX,hubY,275,t,P.rule);
      const items=ending?['Agents','Queues','Memory','Tools','Review','Canvas']:['Claude','Tasks','Codex','Context','Tools','Changes'];
      items.forEach((name,i)=>{
        const a=i*Math.PI/3-.7;const targetX=hubX+Math.cos(a)*175,targetY=hubY+Math.sin(a)*190;
        const p=ramp(t,.15+i*.19,3.2);const startX=hubX+Math.cos(a)*360,startY=hubY+Math.sin(a)*620;
        const x=startX+(targetX-startX)*p+Math.sin(t*.5+i)*6*p,y=startY+(targetY-startY)*p+Math.cos(t*.45+i)*6*p;
        line(hubX,hubY,x,y,ramp(t,2.1+i*.15),i%2?P.green:P.lilac,60);
        card(x,y,220,100,name,'',i%2?P.green:P.lilac,ramp(t,i*.15));
      });
      c.save();c.globalAlpha=ramp(t,1.2);logoAt(hubX,hubY,145);c.restore();
      c.restore();
      if(ending){c.save();c.globalAlpha=ramp(t,3.5);box(365,560,510,112,P.cream,null,56);text('Explore on GitHub  ↗',365,560,42,P.ink,600);c.restore();}
      return;
    }
    heading(ch,t);
    diagramClip();
    if(ch.key==='agents') {
      // Providers assemble into the conductor's graph; worktree lanes stay separate.
      line(800,390,350,520,ramp(t,1.5),P.lilac,-120);line(800,390,1250,520,ramp(t,1.7),P.green,120);
      arrive(t,.15,800,355,800,0,()=>card(800,355,450,150,'Project conductor','One project in view',P.amber));
      arrive(t,.5,350,540,-350,520,()=>card(350,540,400,145,'Claude','Coding agent',P.lilac));
      arrive(t,.8,1250,540,1950,520,()=>card(1250,540,400,145,'Codex','Coding agent',P.green));
      ['Build','Review','Research'].forEach((name,i)=>{const x=320+i*480;line(i===2?1250:350,610,x,710,ramp(t,3+i*.35),i===1?P.amber:P.green,100);arrive(t,2.5+i*.4,x,755,x,1050,()=>card(x,755,390,140,name,'Isolated git worktree',i===1?P.amber:P.green));});
      c.save();c.globalAlpha=ramp(t,6);text('Teams  /  roles  /  groups',800,650,35,P.muted);c.restore();
    } else if(ch.key==='queue') {
      const cols=[320,800,1280];
      cols.forEach((x,i)=>{c.save();c.globalAlpha=ramp(t,.1+i*.18);box(x,555,400,465,'#1b1e24');text(['Ready','Working','Review'][i],x,410,42,P.muted);c.restore();});
      arrive(t,.2,320,315,-400,315,()=>card(320,315,320,95,'Issue intake','',P.amber));
      arrive(t,.5,1280,315,1950,315,()=>card(1280,315,320,95,'Schedules','',P.lilac));
      line(320,365,320,465,ramp(t,1.4),P.amber);line(1280,365,800,465,ramp(t,1.7),P.lilac,-100);
      line(320,555,800,555,ramp(t,2),P.green,80,6);line(800,555,1280,555,ramp(t,5),P.green,80,6);
      cols.forEach((x,i)=>arrive(t,1.1+i*1.3,x,510,x-520,420,()=>card(x,510,345,130,['Plan','Build','Check'][i],'Dependency '+(i+1),i===2?P.green:P.lilac)));
      const travel=ramp(t,5.6,3);dot(320+960*travel,637,12,P.green);
      c.save();c.globalAlpha=ramp(t,3.8);c.strokeStyle=P.amber;c.lineWidth=5;c.beginPath();c.arc(800,680,36,Math.PI*.4,Math.PI*(.4+1.7*ramp(t,4,2)));c.stroke();text('Retry when needed',800,758,36,P.amber);c.restore();
    } else if(ch.key==='memory') {
      ring(800,530,485,t);ring(800,530,340,t);
      const notes=[['Decision',350,400],['Shared fact',1250,400],['Backlink',350,685],['New session',1250,685]];
      notes.forEach(([name,x,y],i)=>{const dy=Math.sin(t*.45+i)*7;line(800,530,x,y+dy,ramp(t,1+i*.5),i%2?P.green:P.lilac,120);arrive(t,.3+i*.25,x,y+dy,i%2?1900:-300,y,()=>card(x,y+dy,350,140,name,i===2?'[[linked note]]':'',i%2?P.green:P.lilac));});
      arrive(t,0,800,530,800,950,()=>card(800,530,350,160,'Memory search','Find the thread',P.amber));
      const p=ramp(t,6,2.6),x=800+450*p,y=780-95*p;
      c.save();c.globalAlpha=ramp(t,4.4)*(1-ramp(t,8.6,.7));line(800,610,800,740,ramp(t,4.8),P.amber);card(x,y,410,120,'Context snapshot','Explicit handoff',P.amber);c.restore();
    } else if(ch.key==='tools') {
      const nodes=[['MCP tools',340,405],['Trust',1260,405],['Secret grants',340,715],['Permissions',1260,715]];
      nodes.forEach(([name,x,y],i)=>{line(800,555,x,y,ramp(t,1.4+i*.4),i%2?P.green:P.lilac,90);arrive(t,.2+i*.3,x,y,i%2?2000:-400,y,()=>card(x,y,410,145,name,['Discover & inspect','Review tool access','Per-agent scope','Choose access'][i],i%2?P.green:P.lilac));});
      c.save();c.globalAlpha=ramp(t,.4);ring(800,555,205,t,P.lilac);ring(800,555,155,t,P.green);logoAt(800,555,125);c.restore();
      c.save();c.globalAlpha=ramp(t,5);box(800,775,360,92,'#2c2930',P.amber);text('Key  ••••••••',800,775,40,P.amber,600);c.restore();
      for(let i=0;i<4;i++){const p=(t*.14+i*.23)%1,a=i*Math.PI/2+.45;dot(800+Math.cos(a)*145*p,555+Math.sin(a)*145*p,5,P.amber);}
    } else if(ch.key==='review') {
      arrive(t,.2,455,535,-500,530,()=>{box(455,535,690,450);text('worktree / changes',150,360,34,P.muted,500,'left');text('−  context: null',160,445,42,'#efa7a2',500,'left');text('+  context: snapshot',160,515,42,P.green,550,'left');text('+  evidence: linked',160,585,42,P.green,550,'left');for(let i=0;i<2;i++){c.fillStyle=P.green;c.globalAlpha=.16*ramp(t,1+i*.65);c.fillRect(130,488+i*70,640*ramp(t,1+i*.65),56);c.globalAlpha=1;}text('Files  /  diff  /  stage',455,690,36,P.lilac);});
      line(800,510,1220,405,ramp(t,2.8),P.green,140);arrive(t,2,1220,405,2000,405,()=>card(1220,405,480,145,'Review','Diff · findings · evidence',P.green));
      line(1220,478,1220,595,ramp(t,5),P.amber);arrive(t,4.2,1220,620,1220,1050,()=>card(1220,620,480,135,'Snapshot branches','Saved context',P.amber));
      line(1220,686,995,790,ramp(t,6.2),P.lilac,-50);line(1220,686,1355,790,ramp(t,6.6),P.green,50);
      c.save();c.globalAlpha=ramp(t,6.5);box(995,800,290,88,P.panel,P.lilac);text('Approach A',995,800,34,P.lilac);box(1355,800,290,88,P.panel,P.green);text('Approach B',1355,800,34,P.green);c.restore();
    } else if(ch.key==='see') {
      // The camera glides across a network while its edges resolve into a project map.
      c.save();c.translate(-25+50*ramp(t,.5,9),breath);
      const nodes=[['Project',460,520],['Agents',240,360],['Tasks',720,350],['Memory',210,720],['Tools',750,740]];
      nodes.slice(1).forEach(([name,x,y],i)=>{line(460,520,x,y,ramp(t,1+i*.35),i%2?P.green:P.lilac,80);});
      nodes.forEach(([name,x,y],i)=>arrive(t,.1+i*.23,x,y,x+(i%2?600:-600),y,()=>card(x,y,i?255:310,i?110:150,name,'',i?P.lilac:P.amber)));
      text('Canvas',470,805,42,P.muted);c.restore();
      arrive(t,1,1240,465,1950,465,()=>{box(1240,465,480,325);text('Resources',1240,355,42,P.cream,600);['CPU','RAM','Context'].forEach((s,i)=>{text(s,1045,430+i*75,34,P.muted,500,'left');box(1320,430+i*75,250,16,P.rule,null,8);const w=(160+i*22)*ramp(t,2+i*.4);if(w>1)box(1195+w/2,430+i*75,w,16,i===2?P.amber:P.green,null,8);});});
      arrive(t,4.3,1240,715,1240,1100,()=>card(1240,715,480,130,'Computer use','Browser · desktop on macOS',P.green));
      c.save();c.globalAlpha=ramp(t,6);text('Local dictation',1315,822,36,P.lilac);for(let i=0;i<9;i++){c.fillStyle=P.lilac;const h=8+Math.abs(Math.sin(t*1.7+i*.8))*24;c.fillRect(1015+i*15,810-h/2,5,h);}c.restore();
    }
    c.restore();
  }
  function draw(time) {
    time=Math.max(0,Math.min(story.durationSeconds-1/story.fps,time));
    const ch=story.chapters.find(x=>time>=x.start&&time<x.end),index=story.chapters.indexOf(ch),local=time-ch.start;
    light=['queue','review'].includes(ch.key);c.fillStyle=light?P.cream:P.ink;c.fillRect(0,0,W,H);
    const glow=c.createRadialGradient(1250,420,50,1250,420,850);glow.addColorStop(0,light?'#e8dfd0':'#303044');glow.addColorStop(1,light?P.cream:P.ink);c.fillStyle=glow;c.fillRect(0,0,W,H);
    c.save();c.globalAlpha=light?.10:.10;c.strokeStyle=light?'#5f6168':P.lilac;c.lineWidth=1;
    const shift=(time*4)%80;for(let x=-80;x<W+80;x+=80){c.beginPath();c.moveTo(x+shift,80);c.lineTo(x+shift,H);c.stroke();}for(let y=80;y<H;y+=80){c.beginPath();c.moveTo(0,y);c.lineTo(W,y);c.stroke();}c.restore();
    const transition=.85;
    if(index&&local<transition){const p=ease(local/transition);c.save();c.globalAlpha=1-p;c.translate(-W*.32*p,0);scene(story.chapters[index-1],story.chapters[index-1].end-story.chapters[index-1].start+local);c.restore();c.save();c.globalAlpha=p;c.translate(W*.32*(1-p),0);scene(ch,local);c.restore();}
    else scene(ch,local);
    caption(ch,local);
    logoAt(113,65,48);text('CHIMERA',154,66,27,light?P.ink:P.muted,650,'left');text(`${String(index+1).padStart(2,'0')}  /  08`,1490,66,25,light?P.ink:P.muted,500,'right');
    c.fillStyle=P.rule;c.fillRect(100,980,1400,3);c.fillStyle=P.lilac;c.fillRect(100,980,1400*time/story.durationSeconds,3);
    return {chapter:ch.key,time};
  }
  return {draw};
}
