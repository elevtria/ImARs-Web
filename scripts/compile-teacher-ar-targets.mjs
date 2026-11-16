import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCanvas,loadImage} from 'canvas';
import * as tf from '@tensorflow/tfjs';
import {OfflineCompiler} from '../tmp/ar-tools/mind/package/src/image-target/offline-compiler.js';
await tf.setBackend('cpu'); await tf.ready();
mkdirSync('assets/teacher-ar',{recursive:true});
const {targets}=JSON.parse(readFileSync('tmp/ar-tools/scene-data.json','utf8'));
const result={};
for(const [index,target] of targets.entries()) {
  const input=readFileSync(target.image), hash=createHash('sha256').update(input).digest('hex').slice(0,12);
  const filename=`marker-${hash}.mind`, path=`assets/teacher-ar/${filename}`;
  if(!existsSync(path)) {
    const image=await loadImage(input), ratio=Math.min(1,512/Math.max(image.width,image.height));
    const canvas=createCanvas(Math.round(image.width*ratio),Math.round(image.height*ratio));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const compiler=new OfflineCompiler();
    await compiler.compileImageTargets([canvas],()=>{});
    writeFileSync(path,compiler.exportData());
  }
  result[target.name]=`/${path}`;
  console.log(`${index+1}/${targets.length} ${target.name}`);
}
writeFileSync('tmp/ar-tools/compiled-targets.json',JSON.stringify(result));
