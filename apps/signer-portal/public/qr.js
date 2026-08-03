/*
 * Kommunsign QR encoder for BankID dynamic QR data.
 * Clean-room implementation of QR Code Model 2 byte mode, error correction L,
 * versions 1-10. No data leaves the browser. The public API intentionally
 * supports only the short ASCII payloads returned by Kommunsign.
 */
(function (root) {
  'use strict';
  const RS_BLOCKS = {
    1:[[1,26,19]],2:[[1,44,34]],3:[[1,70,55]],4:[[1,100,80]],5:[[1,134,108]],
    6:[[2,86,68]],7:[[2,98,78]],8:[[2,121,97]],9:[[2,146,116]],10:[[2,86,68],[2,87,69]],
  };
  const ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x=1; for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;} for(let i=255;i<512;i++)EXP[i]=EXP[i-255];
  const mul=(a,b)=>a===0||b===0?0:EXP[LOG[a]+LOG[b]];
  function blocks(version){const out=[];for(const [count,total,data] of RS_BLOCKS[version])for(let i=0;i<count;i++)out.push({total,data});return out;}
  function appendBits(value,length,out){if(length<0||length>31||value>>>length!==0)throw new Error('QR_BIT_INPUT_INVALID');for(let i=length-1;i>=0;i--)out.push((value>>>i)&1);}
  function utf8(text){return Array.from(new TextEncoder().encode(text));}
  function selectVersion(byteLength){for(let version=1;version<=10;version++){const data=blocks(version).reduce((n,b)=>n+b.data,0);const countBits=version<10?8:16;if(4+countBits+byteLength*8<=data*8)return version;}throw new Error('QR_DATA_TOO_LONG');}
  function dataCodewords(bytes,version){const count=blocks(version).reduce((n,b)=>n+b.data,0),bits=[];appendBits(4,4,bits);appendBits(bytes.length,version<10?8:16,bits);for(const byte of bytes)appendBits(byte,8,bits);const capacity=count*8;appendBits(0,Math.min(4,capacity-bits.length),bits);while(bits.length%8)bits.push(0);for(let pad=0xec;bits.length<capacity;pad^=0xec^0x11)appendBits(pad,8,bits);const out=[];for(let i=0;i<bits.length;i+=8){let n=0;for(let j=0;j<8;j++)n=(n<<1)|bits[i+j];out.push(n);}return out;}
  function generator(degree){let result=[1];for(let i=0;i<degree;i++){const next=new Array(result.length+1).fill(0);for(let j=0;j<result.length;j++){next[j]^=result[j];next[j+1]^=mul(result[j],EXP[i]);}result=next;}return result;}
  function remainder(data,degree){const gen=generator(degree),rem=new Array(degree).fill(0);for(const byte of data){const factor=byte^rem.shift();rem.push(0);for(let i=0;i<degree;i++)rem[i]^=mul(gen[i+1],factor);}return rem;}
  function allCodewords(data,version){const specs=blocks(version),dataBlocks=[],eccBlocks=[];let offset=0,maxData=0,maxEcc=0;for(const spec of specs){const part=data.slice(offset,offset+spec.data);offset+=spec.data;const eccCount=spec.total-spec.data;dataBlocks.push(part);eccBlocks.push(remainder(part,eccCount));maxData=Math.max(maxData,part.length);maxEcc=Math.max(maxEcc,eccCount);}const out=[];for(let i=0;i<maxData;i++)for(const part of dataBlocks)if(i<part.length)out.push(part[i]);for(let i=0;i<maxEcc;i++)for(const part of eccBlocks)if(i<part.length)out.push(part[i]);return out;}
  function makeMatrix(version,codewords){const size=version*4+17,modules=Array.from({length:size},()=>Array(size).fill(false)),func=Array.from({length:size},()=>Array(size).fill(false));
    const set=(xx,yy,dark)=>{if(xx>=0&&yy>=0&&xx<size&&yy<size){modules[yy][xx]=dark;func[yy][xx]=true;}};
    const finder=(cx,cy)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const dist=Math.max(Math.abs(dx),Math.abs(dy));set(cx+dx,cy+dy,dist!==2&&dist!==4);}};
    for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}finder(3,3);finder(size-4,3);finder(3,size-4);
    const align=ALIGN[version];for(const yy of align)for(const xx of align){if(func[yy][xx])continue;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(xx+dx,yy+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}
    const format=(mask)=>{const data=(1<<3)|mask;let rem=data;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);const bits=((data<<10)|rem)^0x5412;const bit=i=>((bits>>>i)&1)!==0;for(let i=0;i<=5;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));for(let i=0;i<8;i++)set(size-1-i,8,bit(i));for(let i=8;i<15;i++)set(8,size-15+i,bit(i));set(8,size-8,true);};
    format(0);
    if(version>=7){let rem=version;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1f25);const bits=(version<<12)|rem;for(let i=0;i<18;i++){const dark=((bits>>>i)&1)!==0;const a=size-11+(i%3),b=Math.floor(i/3);set(a,b,dark);set(b,a,dark);}}
    let bitIndex=0,up=true;for(let right=size-1;right>=1;right-=2){if(right===6)right--;for(let vert=0;vert<size;vert++){const yy=up?size-1-vert:vert;for(let j=0;j<2;j++){const xx=right-j;if(func[yy][xx])continue;const bit=bitIndex<codewords.length*8?((codewords[bitIndex>>>3]>>>(7-(bitIndex&7)))&1)!==0:false;modules[yy][xx]=bit;bitIndex++;}}up=!up;}
    const maskBit=(mask,xx,yy)=>[ (xx+yy)%2===0, yy%2===0, xx%3===0, (xx+yy)%3===0, (Math.floor(yy/2)+Math.floor(xx/3))%2===0, (xx*yy)%2+(xx*yy)%3===0, ((xx*yy)%2+(xx*yy)%3)%2===0, ((xx+yy)%2+(xx*yy)%3)%2===0 ][mask];
    const apply=(mask)=>{for(let yy=0;yy<size;yy++)for(let xx=0;xx<size;xx++)if(!func[yy][xx]&&maskBit(mask,xx,yy))modules[yy][xx]=!modules[yy][xx];};
    const penalty=()=>{let score=0;for(const horizontal of [true,false])for(let a=0;a<size;a++){let runColor=false,run=0;for(let b=0;b<size;b++){const color=horizontal?modules[a][b]:modules[b][a];if(b===0||color!==runColor){if(run>=5)score+=3+run-5;runColor=color;run=1;}else run++;}if(run>=5)score+=3+run-5;}for(let yy=0;yy<size-1;yy++)for(let xx=0;xx<size-1;xx++){const c=modules[yy][xx];if(c===modules[yy][xx+1]&&c===modules[yy+1][xx]&&c===modules[yy+1][xx+1])score+=3;}const pattern=[true,false,true,true,true,false,true];for(const horizontal of [true,false])for(let a=0;a<size;a++)for(let b=0;b<=size-7;b++){let match=true;for(let k=0;k<7;k++){const c=horizontal?modules[a][b+k]:modules[b+k][a];if(c!==pattern[k]){match=false;break;}}if(match){let before=true,after=true;for(let k=1;k<=4;k++){if(b-k>=0&&(horizontal?modules[a][b-k]:modules[b-k][a]))before=false;if(b+6+k<size&&(horizontal?modules[a][b+6+k]:modules[b+6+k][a]))after=false;}if((b>=4&&before)||(b+11<size&&after))score+=40;}}let dark=0;for(const row of modules)for(const c of row)if(c)dark++;score+=(Math.ceil(Math.abs(dark*20-size*size*10)/(size*size))-1)*10;return score;};
    const best=0;apply(best);format(best);return {size,get:(xx,yy)=>modules[yy][xx]};
  }
  function encode(text){if(typeof text!=='string'||text.length===0)throw new Error('QR_DATA_INVALID');const bytes=utf8(text),version=selectVersion(bytes.length);return makeMatrix(version,allCodewords(dataCodewords(bytes,version),version));}
  function svg(text,scale=6,border=4){const qr=encode(text),dimension=(qr.size+border*2)*scale;let path='';for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.get(x,y))path+=`M${(x+border)*scale},${(y+border)*scale}h${scale}v${scale}h-${scale}z`;return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="BankID QR-kod" viewBox="0 0 ${dimension} ${dimension}" width="${dimension}" height="${dimension}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;}
  function renderSvg(element,text){if(!element)throw new Error('QR_TARGET_REQUIRED');element.innerHTML=svg(text);}
  const api={encode,svg,renderSvg};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.KommunsignQr=api;
})(typeof window!=='undefined'?window:globalThis);
