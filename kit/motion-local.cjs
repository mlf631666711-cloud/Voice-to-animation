'use strict';
// Measurement face: local image change in 8x6 cells of a 64x36 gray decode.
// Normalize the time baseline to about 100ms so FPS does not set sensitivity.
// This detects change, not meaningful choreography or subjective quality.
function measureMotion(pixels,fps){
 if(!Number.isFinite(fps)||fps<=0||!pixels||pixels.length%2304)throw Error('Invalid motion samples');
 const count=pixels.length/2304,lag=Math.max(1,Math.round(fps/10));
 if(count<=lag)throw Error('No measurable temporal window');
 let run=0,worst=0,at=0,maxLocal=0;
 for(let i=lag;i<count;i++){
  let local=0;
  for(let y=0;y<36;y+=6)for(let x=0;x<64;x+=8){let sum=0;
   for(let dy=0;dy<6;dy++)for(let dx=0;dx<8;dx++){const j=(y+dy)*64+x+dx;sum+=Math.abs(pixels[i*2304+j]-pixels[(i-lag)*2304+j])}
   local=Math.max(local,sum/48);
  }
  maxLocal=Math.max(maxLocal,local);
  if(local<.35){run++;if(run>worst){worst=run;at=i/fps}}else run=0;
 }
 // Include the temporal window covered by a quiet run, not just its endpoints.
 return {count,lag,worstFrames:worst?worst+lag-1:0,at,maxLocal};
}
module.exports={measureMotion};
