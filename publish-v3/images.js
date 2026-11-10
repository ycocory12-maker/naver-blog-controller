'use strict';
function imageInfo(buffer) {
  if(buffer.length>=24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.toString('ascii',12,16)==='IHDR') return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20),type:'image/png'};
  if(buffer.length>4 && buffer[0]===255 && buffer[1]===216) {
    let p=2;
    while(p+4<=buffer.length) {
      if(buffer[p++]!==255) throw Error('invalid_jpeg_marker');
      while(buffer[p]===255)p++;
      const marker=buffer[p++];if(marker===217 || marker===218)break;
      if(marker===1 || (marker>=208 && marker<=215))continue;
      if(p+2>buffer.length)break;const length=buffer.readUInt16BE(p);
      if(length<2 || p+length>buffer.length)throw Error('invalid_jpeg_segment');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if(length<8)throw Error('invalid_jpeg_frame');
        return {height:buffer.readUInt16BE(p+3),width:buffer.readUInt16BE(p+5),type:'image/jpeg'};
      }
      p+=length;
    }
  }
  throw Error('invalid_image');
}
module.exports={imageInfo};
