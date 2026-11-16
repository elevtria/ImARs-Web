import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCanvas,loadImage} from 'canvas';
import * as tf from '@tensorflow/tfjs';
import {OfflineCompiler} from '../tmp/ar-tools/mind/package/src/image-target/offline-compiler.js';
import {unzipSync} from '../tmp/ar-tools/three/package/examples/jsm/libs/fflate.module.js';
import {encode,decode} from '@msgpack/msgpack';
await tf.setBackend('cpu'); await tf.ready();
mkdirSync('assets/teacher-ar',{recursive:true});
const {targets}=JSON.parse(readFileSync('tmp/ar-tools/scene-data.json','utf8'));
const archive=unzipSync(readFileSync('assets/markers/all-3d-markers.zip'));
const archiveNames={
  'condesation marker':['Condensation and Evapuration Marker.png'], 'apple marker':['Apple Marker.png'],
  'sound_wave marker':['Water Wave Marker.png'], 'FoodWeb':['Food Web Marker.png'], 'nail  marker':['Nail Marker.png'],
  'wedege marker':['Wedge Marker.png'], 'screw marker':['Screw Marker.png'],
  'Longitudinal Term 2 Marker':['Longitudinal Term 2 Marker.png','Longitudinal Marker.png'],
  'blood_vessel marker (2)':['Blood Vessel Marker.png'], 'elting marker':['Melting Marker.png'],
  'blood_vessel marker':['Blood Marker.png'], 'heart marker':['heart Marker.png'], 'volcano marker':['Volcano Marker.png'],
  'season marker':['4 Season Marker.png'], 'paper marker':['Paper Marker.png'], 'freezing marker':['Freezin marker.png'],
  'eclipse marker':['Eclipse Marker.png'], 'magnet marker':['Magnet Marker.png'], 'pulley':['Pulley Marker.png'],
  'inclined marker':['Inclined Marker.png'], 'Constellation Marker':['Constellation Marker.png'],
  'lever marker':['Lever Marker.png'], 'wheel marker':['Wheel Marker.png']
};
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const result={};
for(const [index,target] of targets.entries()) {
  const input=readFileSync(target.image), sourceHash=hashBytes(input);
  const variants=[{name:'Classroom marker',bytes:input,background:'#ffffff'}];
  for(const name of archiveNames[target.name]||[]) {
    const matches=Object.entries(archive).filter(([path])=>path.split('/').pop().toLowerCase()===name.toLowerCase());
    if(!matches.length)throw Error(`Downloaded marker is missing: ${name}`);
    for(const [,bytes] of matches)variants.push({name,bytes,background:'#ffffff'});
  }
  // Keep recognition of the earlier transparent/black references as well.
  variants.push({name:'App marker',bytes:input,background:'#000000'});
  const dataList=[], pixelHashes=new Set(), sourceHashes=new Set();
  for(const variant of variants) {
    sourceHashes.add(hashBytes(variant.bytes));
    const image=await loadImage(variant.bytes), ratio=Math.min(1,512/Math.max(image.width,image.height));
    const canvas=createCanvas(Math.round(image.width*ratio),Math.round(image.height*ratio));
    const context=canvas.getContext('2d');
    context.fillStyle=variant.background; context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const pixelHash=hashBytes(pixels);
    if(pixelHashes.has(pixelHash))continue;
    pixelHashes.add(pixelHash);
    const cached=`tmp/ar-tools/variant-${pixelHash}.mind`;
    const legacy=`assets/teacher-ar/marker-${sourceHash.slice(0,12)}.mind`;
    if(variant.name==='App marker'&&existsSync(legacy)) {
      dataList.push(...decode(readFileSync(legacy)).dataList);
    } else if(existsSync(cached)) {
      dataList.push(...decode(readFileSync(cached)).dataList);
    } else {
      const compiler=new OfflineCompiler();
      await compiler.compileImageTargets([canvas],()=>{});
      const bytes=compiler.exportData(); writeFileSync(cached,bytes);
      dataList.push(...decode(bytes).dataList);
    }
  }
  const bytes=encode({v:2,dataList}), path=`assets/teacher-ar/marker-v2-${hashBytes(bytes).slice(0,16)}.mind`;
  writeFileSync(path,bytes);
  result[target.name]={url:`/${path}`,count:dataList.length,sources:[...sourceHashes]};
  console.log(`${index+1}/${targets.length} ${target.name}: ${dataList.length} marker versions`);
}
writeFileSync('tmp/ar-tools/compiled-targets.json',JSON.stringify(result));
