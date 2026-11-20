import fs from 'node:fs/promises';
import sharp from 'sharp';
const W=800,H=520,FPS=8,N=112;
const marker=(await sharp('assets/teacher-ar/asset-85af6d0a0f731a80.png').resize(240,240).flatten({background:'#fff'}).png().toBuffer()).toString('base64');
const image=(x,y,w)=>`<image x="${x}" y="${y}" width="${w}" height="${w}" href="data:image/png;base64,${marker}"/>`;
const steps=[['Prepare your flashcard','Print an ImARs marker. Keep the full picture clear.'],['Open AR Classroom','Choose Scan markers and allow the laptop camera.'],['Show it to the webcam','Face the printed image toward the camera above your screen.'],['Hold the card steady','Wait for Marker found, then explore the model.']];
const clamp=x=>Math.max(0,Math.min(1,x)),ease=x=>x*x*(3-2*x);
function svg(t){
 const step=t<3?0:t<6?1:t<10?2:3, shift=ease(clamp((t-6)/2))*24;
 const cardX=607-shift, bob=step>=2?Math.sin(t*1.2)*2:0, found=t>11.1;
 const progress=steps.map((_,i)=>`<circle cx="${330+i*46}" cy="481" r="${i===step?13:10}" fill="${i<=step?'#73c9ff':'#345372'}"/><text x="${330+i*46}" y="486" text-anchor="middle" font-size="13" font-weight="700" fill="${i<=step?'#102e54':'#c6dcf1'}">${i+1}</text>`).join('');
 const cameraView=step>=2?`<rect x="151" y="180" width="331" height="162" rx="4" fill="#dceaf6"/>${image(254,199,120)}<path d="M245 219v-28h28m85 0h28v28m0 84v27h-28m-85 0h-28v-27" fill="none" stroke="${found?'#13825b':'#1262e8'}" stroke-width="4" stroke-linecap="round"/>${found?`<rect x="257" y="313" width="116" height="22" rx="11" fill="#17633f"/><text x="315" y="328" text-anchor="middle" font-size="10" fill="white" font-weight="700">Marker found</text>`:`<path d="M256 ${222+Math.sin(t*3)*23}h119" stroke="#149fc9" stroke-width="2"/>`}`:`<text x="316" y="219" text-anchor="middle" font-size="21" font-weight="700" fill="#173858">AR Classroom</text><text x="316" y="243" text-anchor="middle" font-size="11" fill="#496583">Your laptop camera is ready to help.</text><rect x="257" y="264" width="119" height="32" rx="9" fill="#1262e8"/><text x="316" y="285" text-anchor="middle" font-size="12" fill="white" font-weight="700">Scan markers</text>`;
 const permission=step===1?`<rect x="208" y="218" width="215" height="105" rx="12" fill="white" stroke="#9dbbd7"/><text x="315" y="245" text-anchor="middle" font-size="13" font-weight="700" fill="#173858">Allow camera access?</text><text x="315" y="266" text-anchor="middle" font-size="10" fill="#496583">Use your laptop webcam to scan.</text><rect x="272" y="279" width="86" height="28" rx="8" fill="#1262e8"/><text x="315" y="298" text-anchor="middle" font-size="12" fill="white" font-weight="700">Allow</text>`:'';
 return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#153d66"/><stop offset="1" stop-color="#0c2038"/></linearGradient></defs><rect width="800" height="520" rx="24" fill="url(#bg)"/><g font-family="Segoe UI,Arial,sans-serif"><text x="35" y="45" fill="#9bd7ff" font-size="12" letter-spacing="2" font-weight="700">IMARS / LAPTOP QUICK START</text><text x="35" y="83" fill="#edf7ff" font-size="31" font-weight="700">Your flashcard. A whole new view.</text><rect x="30" y="109" width="740" height="282" rx="20" fill="#183957" stroke="#456e94"/>
 <ellipse cx="385" cy="368" rx="285" ry="12" fill="#0a233b"/>
 <rect x="129" y="145" width="375" height="211" rx="13" fill="#0a192b" stroke="#8eb7d8" stroke-width="3"/><rect x="141" y="165" width="351" height="180" rx="5" fill="#edf6fc"/><circle cx="316" cy="155" r="4" fill="${step>0?'#63dcb2':'#54728d'}"/>
 ${step===0?`<path d="M316 151V132h63" fill="none" stroke="#9bd7ff" stroke-width="1.4"/><text x="387" y="136" fill="#d5eaff" font-size="11">Laptop webcam</text>`:''}
 ${cameraView}${permission}<path d="M129 354H504L535 374H97Z" fill="#a5c4dc" stroke="#cbe0ee" stroke-width="1.5"/><path d="M280 355h74l9 8h-92z" fill="#7699b4"/>
 ${step>=2?`<path d="M${cardX-8} 215Q510 126 328 155" fill="none" stroke="#89cff8" stroke-width="2" stroke-dasharray="7 6" opacity=".7"/><path d="M336 148l-10 7 11 5" fill="none" stroke="#89cff8" stroke-width="2"/>`:''}
 <g transform="translate(0 ${bob})"><path d="M${cardX+28} 342c-11 5-16 16-12 27h77c7-22-7-30-23-30" fill="#e4ad83" stroke="#bc815d" stroke-width="2"/><rect x="${cardX}" y="190" width="126" height="159" rx="9" fill="#fcfcfc" stroke="#8eb7d8" stroke-width="3"/><text x="${cardX+63}" y="211" text-anchor="middle" font-size="11" font-weight="700" fill="#345d87">IMARS FLASHCARD</text>${image(cardX+10,221,106)}<text x="${cardX+63}" y="340" text-anchor="middle" font-size="9" fill="#173858">Water cycle</text><path d="M${cardX-1} 312c-12-8-19-1-16 10l15 23 10-1v-22z" fill="#e4ad83" stroke="#bc815d" stroke-width="1.5"/></g>
 <text x="40" y="426" fill="#f0f7ff" font-size="23" font-weight="700">${step+1}. ${steps[step][0]}</text><text x="40" y="452" fill="#c1d9ef" font-size="13">${steps[step][1]}</text>${progress}<text x="760" y="486" text-anchor="end" fill="#9cbedb" font-size="9">Illustration / camera stays off</text></g></svg>`;
}
await fs.mkdir('tmp/scan-preview',{recursive:true});
const frames=[];
for(let i=0;i<N;i++){
 const raw=Buffer.from(svg(i/FPS)); frames.push(await sharp(raw).ensureAlpha().raw().toBuffer());
 if([0,32,64,104].includes(i))await sharp(raw).png().toFile(`tmp/scan-preview/laptop-step-${i}.png`);
}
await sharp(Buffer.concat(frames),{raw:{width:W,height:H*N,channels:4,pageHeight:H}}).gif({delay:Array(N).fill(125),loop:0,colours:128,dither:0}).toFile('assets/guides/ImARs-Scan-Tutorial.gif');
await fs.copyFile('tmp/scan-preview/laptop-step-0.png', 'assets/guides/ImARs-Scan-Tutorial-Still.png');
console.log('Laptop flashcard animation and still image rendered.');
