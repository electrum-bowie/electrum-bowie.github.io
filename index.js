AFRAME.registerComponent("gaussian_splatting", {
  schema: {
    src: { type: 'string', default: "train.splat" },
    pixelRatio: { type: 'number', default: 0.5 },
    xrPixelRatio: { type: 'number', default: 0.9 }
  },
  init: function () {
    const pr = this.data.pixelRatio < 0 ? window.devicePixelRatio : this.data.pixelRatio;
    const xrpr = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
    this.el.sceneEl.renderer.setPixelRatio(pr);
    this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(xrpr);
    this.originalBuffers = [];
    this.needsQualityUpdate = false;
    this.initGL(
      this.el.sceneEl.camera.el.components.camera.camera,
      this.el.object3D,
      this.el.sceneEl.renderer
    );
    this.loadData(this.data.src);
  },
  initGL: function (camera, object, renderer) {
    this.camera = camera;
    this.object = object;
    this.renderer = renderer;
    this.textureReady = false;
    this.object.frustumCulled = false;
    this.centerAndScaleData = new Float32Array(4096 * 4096 * 4);
    this.covAndColorData = new Uint32Array(4096 * 4096 * 4);
    this.centerAndScaleTexture = new THREE.DataTexture(this.centerAndScaleData, 4096, 4096, THREE.RGBA, THREE.FloatType);
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture = new THREE.DataTexture(this.covAndColorData, 4096, 4096, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    this.covAndColorTexture.internalFormat = "RGBA32UI";
    this.covAndColorTexture.needsUpdate = true;
    const size = 256;
    this.occlusionFBO = new THREE.WebGLRenderTarget(size, size, { format: THREE.RedFormat, type: THREE.FloatType });
    let idxArray = new Uint32Array(4096 * 4096);
    const idxAttr = new THREE.InstancedBufferAttribute(idxArray, 1, false);
    idxAttr.setUsage(THREE.DynamicDrawUsage);
    const baseGeo = new THREE.BufferGeometry();
    const posArr = new Float32Array(6 * 3);
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    baseGeo.setAttribute('position', posAttr);
    posAttr.setXYZ(0, -2, -2, 0);
    posAttr.setXYZ(1,  2,  2, 0);
    posAttr.setXYZ(2, -2,  2, 0);
    posAttr.setXYZ(3,  2, -2, 0);
    posAttr.setXYZ(4,  2,  2, 0);
    posAttr.setXYZ(5, -2, -2, 0);
    posAttr.needsUpdate = true;
    const instGeo = new THREE.InstancedBufferGeometry().copy(baseGeo);
    instGeo.setAttribute('splatIndex', idxAttr);
    instGeo.instanceCount = 1;
    const commonUniforms = {
      viewport: { value: new Float32Array([1980, 1080]) },
      focal:    { value: 1000.0 },
      centerAndScaleTexture: { value: this.centerAndScaleTexture },
      covAndColorTexture:    { value: this.covAndColorTexture },
      gsProjectionMatrix:    { value: this.getProjectionMatrix() },
      gsModelViewMatrix:     { value: this.getModelViewMatrix() }
    };
    const vert = `
precision highp usampler2D;
out vec4 vColor;
out vec2 vPosition;
uniform vec2 viewport;
uniform float focal;
uniform mat4 gsProjectionMatrix;
uniform mat4 gsModelViewMatrix;
attribute uint splatIndex;
uniform sampler2D centerAndScaleTexture;
uniform usampler2D covAndColorTexture;
vec2 unpackInt16(in uint value){
  int v=int(value);
  int v0=v>>16;
  int v1=(v&0xFFFF);
  if((v&0x8000)!=0)v1|=0xFFFF0000;
  return vec2(float(v1),float(v0));
}
void main(){
  ivec2 tp=ivec2(splatIndex%uint(4096),splatIndex/uint(4096));
  vec4 cs=texelFetch(centerAndScaleTexture,tp,0);
  vec4 c=vec4(cs.xyz,1);
  vec4 cam=gsModelViewMatrix*c;
  vec4 p=gsProjectionMatrix*cam;
  float b=2.0*p.w;
  if(p.z<-p.w||p.x<-b||p.x>b||p.y<-b||p.y>b){
    gl_Position=vec4(0,0,2,1);
    return;
  }
  uvec4 cd=texelFetch(covAndColorTexture,tp,0);
  vec2 c1=unpackInt16(cd.x)*cs.w;
  vec2 c2=unpackInt16(cd.y)*cs.w;
  vec2 c3=unpackInt16(cd.z)*cs.w;
  mat3 V=mat3(c1.x,c1.y,c3.x,c1.y,c3.y,c3.x,c3.x,c3.x,c3.y);
  mat3 J=mat3(focal/cam.z,0.,-focal*cam.x/(cam.z*cam.z),0.,-focal/cam.z,focal*cam.y/(cam.z*cam.z),0.,0.,0.);
  mat3 T=transpose(mat3(gsModelViewMatrix))*J;
  mat3 cov=transpose(T)*V*T;
  vec2 vc=vec2(p)/p.w;
  float d1=cov[0][0]+0.3;
  float od=cov[0][1];
  float d2=cov[1][1]+0.3;
  float mid=0.5*(d1+d2);
  float rad=length(vec2((d1-d2)/2.0,od));
  float l1=mid+rad;
  float l2=max(mid-rad,0.1);
  vec2 dv=normalize(vec2(od,l1-d1));
  vec2 v1=min(sqrt(2.0*l1),1024.0)*dv;
  vec2 v2=min(sqrt(2.0*l2),1024.0)*vec2(dv.y,-dv.x);
  uint cu=cd.w;
  vColor=vec4(float(cu&uint(0xFF))/255.,float((cu>>uint(8))&uint(0xFF))/255.,float((cu>>uint(16))&uint(0xFF))/255.,float(cu>>uint(24))/255.);
  vPosition=position.xy;
  gl_Position=vec4(vc+position.x*v2/viewport*2.0+position.y*v1/viewport*2.0,p.z/p.w,1);
}`;
    const frag = `
in vec4 vColor;
in vec2 vPosition;
void main(){
  float A=-dot(vPosition,vPosition);
  if(A<-4.0)discard;
  float B=exp(A)*vColor.a;
  gl_FragColor=vec4(vColor.rgb,B);
}`;
    this.coverageMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, commonUniforms),
      vertexShader: vert,
      fragmentShader: `
in vec4 vColor;
void main(){
  gl_FragColor = vec4(vColor.a,0,0,0);
}`
    });
    this.mainMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, commonUniforms, {
        occlusionTex: { value: this.occlusionFBO.texture },
        occlThreshold: { value: 0.99 }
      }),
      vertexShader: vert.replace(
        "void main(){",
        `out vec2 vCenter;
uniform sampler2D occlusionTex;
uniform float occlThreshold;
void main(){
  vCenter = vec2((gl_Position.x/gl_Position.w)*0.5+0.5,(gl_Position.y/gl_Position.w)*0.5+0.5);
  if(texture(occlusionTex,vCenter).r>=occlThreshold){gl_Position=vec4(2,2,2,1);return;}`
      ),
      fragmentShader: frag,
      blending: THREE.CustomBlending,
      blendSrcAlpha: THREE.OneFactor,
      depthTest: true,
      depthWrite: false,
      transparent: true
    });
    const mesh = new THREE.Mesh(instGeo, this.mainMaterial);
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.object.add(mesh);
    this.worker = new Worker(URL.createObjectURL(new Blob(["(", this.createWorker.toString(), ")(self)"], { type: "application/javascript" })));
    this.worker.onmessage = (e) => {
      const a = new Uint32Array(e.data.sortedIndexes);
      mesh.geometry.attributes.splatIndex.set(a);
      mesh.geometry.attributes.splatIndex.needsUpdate = true;
      mesh.geometry.instanceCount = a.length;
      this.sortReady = true;
    };
    this.sortReady = true;
  },
  loadData: function (src) {
    this.loadedVertexCount = 0;
    this.rowLength = 3*4+3*4+4+4;
    this.worker.postMessage({ method: "clear" });
    this.originalBuffers = [];
    this.isCaching = true;
    fetch(src).then(async data => {
      const reader = data.body.getReader();
      let bytesDownloaded=0,bytesProcessed=0,chunks=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const total = data.headers.get("Content-Length");
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        bytesDownloaded+=value.length;
        chunks.push(value);
        if(!this.textureReady&&this.renderer.properties.get(this.centerAndScaleTexture)&&this.renderer.properties.get(this.covAndColorTexture))this.textureReady=true;
        const remains=bytesDownloaded-bytesProcessed;
        if(this.textureReady&&remains>this.rowLength){
          const vc=Math.floor(remains/this.rowLength);
          const buf=new Uint8Array(vc*this.rowLength);
          let off=0;
          const cat=new Uint8Array(remains);
          let o2=0;
          for(const c of chunks){cat.set(c,o2);o2+=c.length;}
          chunks=[];
          buf.set(cat.subarray(0,buf.length),0);
          bytesProcessed+=buf.length;
          this.pushDataBuffer(buf.buffer,vc);
        }
      }
      const rem=bytesDownloaded-bytesProcessed;
      if(rem>0){
        let cat=new Uint8Array(rem),o=0;
        for(const c of chunks){cat.set(c,o);o+=c.length;}
        this.pushDataBuffer(this.processPlyBuffer(cat.buffer),Math.floor(cat.byteLength/this.rowLength));
      }
    }).finally(()=>{
      this.isCaching=false;
      if(this.needsQualityUpdate){this.needsQualityUpdate=false;this.updateQuality();}
    });
  },
  pushDataBuffer: function(buffer,vc){
    if(this.loadedVertexCount+vc>4096*4096)vc=4096*4096-this.loadedVertexCount;
    if(vc<=0)return;
    if(this.isCaching)this.originalBuffers.push(buffer.slice(0));
    const u8=new Uint8Array(buffer);
    const f32=new Float32Array(buffer);
    const mats=new Float32Array(vc*16);
    const csc=this.centerAndScaleData;
    const cc=new Uint8Array(this.covAndColorData.buffer);
    const ci=new Int16Array(this.covAndColorData.buffer);
    let added=0;
    for(let i=0;i<vc;i++){
      const q=new THREE.Quaternion(
        (u8[32*i+29]-128)/128,(u8[32*i+30]-128)/128,-(u8[32*i+31]-128)/128,(u8[32*i+28]-128)/128
      );
      const cen=new THREE.Vector3(f32[8*i],f32[8*i+1],-f32[8*i+2]);
      const sc=new THREE.Vector3(f32[8*i+3],f32[8*i+4],f32[8*i+5]);
      const maxS=Math.max(sc.x,sc.y,sc.z);
      if(maxS>9||maxS<0.002)continue;
      const m=new THREE.Matrix4();
      m.makeRotationFromQuaternion(q);
      m.transpose();
      m.scale(sc);
      const mt=m.clone().transpose();
      m.premultiply(mt);
      m.setPosition(cen);
      const idxs=[0,1,2,5,6,10];
      let mv=0;
      for(const j of idxs)mv=Math.max(mv,Math.abs(m.elements[j]));
      const dst1=this.loadedVertexCount*4+added*4;
      csc[dst1]=cen.x;csc[dst1+1]=cen.y;csc[dst1+2]=cen.z;csc[dst1+3]=mv/32767;
      const dst2=this.loadedVertexCount*8+added*8;
      for(let j=0;j<6;j++)ci[dst2+j]=parseInt(m.elements[idxs[j]]*32767/mv);
      const dst3=this.loadedVertexCount*16+(added*4+3)*4;
      cc[dst3]=u8[32*i+24];cc[dst3+1]=u8[32*i+25];cc[dst3+2]=u8[32*i+26];cc[dst3+3]=u8[32*i+27];
      m.elements[15]=maxS*(u8[32*i+27]/255);
      for(let j=0;j<16;j++)mats[added*16+j]=m.elements[j];
      added++;
    }
    const gl=this.renderer.getContext();
    let remain=added;
    while(remain>0){
      const x=this.loadedVertexCount%4096;
      const y=Math.floor(this.loadedVertexCount/4096);
      let w,h;
      if(x!==0){
        w=Math.min(4096,x+remain)-x;h=1;
      } else if(Math.floor(remain/4096)>0){
        w=4096;h=Math.floor(remain/4096);
      } else {
        w=remain%4096;h=1;
      }
      const prop1=this.renderer.properties.get(this.centerAndScaleTexture);
      gl.bindTexture(gl.TEXTURE_2D,prop1.__webglTexture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,w,h,THREE.RGBA,THREE.FLOAT,this.centerAndScaleData,this.loadedVertexCount*4);
      const prop2=this.renderer.properties.get(this.covAndColorTexture);
      gl.bindTexture(gl.TEXTURE_2D,prop2.__webglTexture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,w,h,THREE.RGBA_INTEGER,THREE.UNSIGNED_INT,this.covAndColorData,this.loadedVertexCount*4);
      this.loadedVertexCount+=w*h;
      remain-=w*h;
    }
    this.worker.postMessage({ method:"push", matrices:mats.buffer }, [mats.buffer]);
  },
  tick: function () {
    if (this.sortReady) {
      this.sortReady = false;
      const cm = this.getModelViewMatrix().elements;
      const view = new Float32Array([cm[2],cm[6],cm[10],cm[14]]);
      const scale = Math.max(this.object.scale.x,this.object.scale.y,this.object.scale.z);
      this.worker.postMessage({ method:"sort", view:view.buffer, scale }, [view.buffer]);
    }
    this.renderer.setRenderTarget(this.occlusionFBO);
    this.renderer.clear();
    this.mesh.material = this.coverageMaterial;
    this.renderer.render(this.mesh, this.camera);
    this.renderer.setRenderTarget(null);
    this.mesh.material = this.mainMaterial;
    this.mainMaterial.uniforms.occlusionTex.value = this.occlusionFBO.texture;
    this.renderer.render(this.mesh, this.camera);
  },
  updateQuality: function () {
    if (this.isCaching) {
      if (this.originalBuffers.length>0) this.needsQualityUpdate = true;
      return;
    }
    if (!this.originalBuffers.length) return;
    this.loadedVertexCount = 0;
    this.mesh.geometry.instanceCount = 0;
    this.worker.postMessage({ method: "clear" });
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture.needsUpdate = true;
    for (const b of this.originalBuffers) this.pushDataBuffer(b.slice(0), b.byteLength/this.rowLength);
    this.sortReady = true;
  },
  getProjectionMatrix: function (cam) {
    cam = cam || this.camera;
    const m = cam.projectionMatrix.clone();
    m.elements[4] *= -1; m.elements[5] *= -1;
    m.elements[6] *= -1; m.elements[7] *= -1;
    return m;
  },
  getModelViewMatrix: function (cam) {
    cam = cam || this.camera;
    const v = cam.matrixWorld.clone();
    v.elements[1]*=-1;v.elements[4]*=-1;v.elements[6]*=-1;v.elements[9]*=-1;v.elements[13]*=-1;
    const o = this.object.matrixWorld.clone();
    o.invert();
    o.elements[1]*=-1; o.elements[4]*=-1; o.elements[6]*=-1; o.elements[9]*=-1; o.elements[13]*=-1;
    o.multiply(v); o.invert();
    return o;
  },
  createWorker: function (self) {
    let mats;
    const sortFn = (m,view,scale=1)=>{
      const n=m.length/16;
      const ds=new Float32Array(n);
      const ids=new Int32Array(n);
      let vc=0,md=-Infinity,mi=Infinity;
      for(let i=0;i<n;i++){
        const d=view[0]*m[16*i+12]+view[1]*m[16*i+13]+view[2]*m[16*i+14]+view[3];
        if(d<0&&m[16*i+15]*scale>-0.001*d){
          ds[vc]=d;ids[vc]=i;
          md=Math.max(md,d);mi=Math.min(mi,d);vc++;
        }
      }
      const inv=(256*256-1)/(md-mi);
      const sz=new Int32Array(ds.buffer);
      const cnt=new Uint32Array(256*256);
      for(let i=0;i<vc;i++){
        sz[i]=((ds[i]-mi)*inv)|0;
        cnt[sz[i]]++;
      }
      const st=new Uint32Array(256*256);
      for(let i=1;i<256*256;i++)st[i]=st[i-1]+cnt[i-1];
      const out=new Uint32Array(vc);
      for(let i=0;i<vc;i++)out[st[sz[i]]++]=ids[i];
      return out;
    };
    self.onmessage = e=>{
      if(e.data.method=="clear")mats=undefined;
      if(e.data.method=="push"){
        const nm=new Float32Array(e.data.matrices);
        mats = mats ? (()=>{const r=new Float32Array(mats.length+nm.length);r.set(mats);r.set(nm,mats.length);return r;})() : nm;
      }
      if(e.data.method=="sort"){
        const out = mats ? sortFn(mats,new Float32Array(e.data.view),e.data.scale) : new Uint32Array(1);
        self.postMessage({ sortedIndexes: out }, [out.buffer]);
      }
    };
  },
  processPlyBuffer: function (buf) {
    const u=new Uint8Array(buf);
    const hdr=new TextDecoder().decode(u.slice(0,1024*10));
    const e="end_header\n";
    const i=hdr.indexOf(e);
    const vc=parseInt(/element vertex (\d+)\n/.exec(hdr)[1]);
    const rowBytes=i+e.length;
    const dv=new DataView(buf,rowBytes);
    let ro=0,offs={},types={},map={double:"getFloat64",int:"getInt32",uint:"getUint32",float:"getFloat32",short:"getInt16",ushort:"getUint16",uchar:"getUint8"};
    hdr.slice(0,i).split("\n").filter(l=>l.startsWith("property ")).forEach(l=>{
      const [p,t,n]=l.split(" ");
      types[n]=map[t]||"getInt8";
      offs[n]=ro;
      ro+=parseInt(types[n].replace(/\D/g,""))/8;
    });
    const sizeList=new Float32Array(vc);
    const idx=new Uint32Array(vc);
    for(let r=0;r<vc;r++){
      idx[r]=r;
      const s=types["scale_0"] ? Math.exp(dv[types["scale_0"]](r*ro+offs["scale_0"],true))*Math.exp(dv[types["scale_1"]](r*ro+offs["scale_1"],true))*Math.exp(dv[types["scale_2"]](r*ro+offs["scale_2"],true)) : 0.01;
      const o=types["opacity"] ? 1/(1+Math.exp(-dv[types["opacity"]](r*ro+offs["opacity"],true))) : 1;
      sizeList[r]=s*o;
    }
    idx.sort((a,b)=>sizeList[b]-sizeList[a]);
    const rl=3*4+3*4+4+4;
    const out=new ArrayBuffer(rl*vc);
    for(let j=0;j<vc;j++){
      const r=idx[j];
      const p=new Float32Array(out,j*rl,3);
      const sc=new Float32Array(out,j*rl+12,3);
      const rgba=new Uint8ClampedArray(out,j*rl+24,4);
      const rot=new Uint8ClampedArray(out,j*rl+28,4);
      if(types["scale_0"]){
        const ql=Math.sqrt(
          dv[types["rot_0"]](r*ro+offs["rot_0"],true)**2+
          dv[types["rot_1"]](r*ro+offs["rot_1"],true)**2+
          dv[types["rot_2"]](r*ro+offs["rot_2"],true)**2+
          dv[types["rot_3"]](r*ro+offs["rot_3"],true)**2
        );
        rot[0]=dv[types["rot_0"]](r*ro+offs["rot_0"],true)/ql*128+128;
        rot[1]=dv[types["rot_1"]](r*ro+offs["rot_1"],true)/ql*128+128;
        rot[2]=dv[types["rot_2"]](r*ro+offs["rot_2"],true)/ql*128+128;
        rot[3]=dv[types["rot_3"]](r*ro+offs["rot_3"],true)/ql*128+128;
        sc[0]=Math.exp(dv[types["scale_0"]](r*ro+offs["scale_0"],true));
        sc[1]=Math.exp(dv[types["scale_1"]](r*ro+offs["scale_1"],true));
        sc[2]=Math.exp(dv[types["scale_2"]](r*ro+offs["scale_2"],true));
      } else {
        sc[0]=sc[1]=sc[2]=0.01;
        rot[0]=255;rot[1]=rot[2]=rot[3]=0;
      }
      p[0]=dv[types["x"]](r*ro+offs["x"],true);
      p[1]=dv[types["y"]](r*ro+offs["y"],true);
      p[2]=dv[types["z"]](r*ro+offs["z"],true);
      if(types["f_dc_0"]){
        const C=0.28209479177387814;
        rgba[0]=(0.5+C*dv[types["f_dc_0"]](r*ro+offs["f_dc_0"],true))*255;
        rgba[1]=(0.5+C*dv[types]["f_dc_1"](r*ro+offs["f_dc_1"],true))*255;
        rgba[2]=(0.5+C*dv[types]["f_dc_2"](r*ro+offs["f_dc_2"],true))*255;
      } else {
        rgba[0]=dv[types["red"]](r*ro+offs["red"],true);
        rgba[1]=dv[types["green"]](r*ro+offs["green"],true);
        rgba[2]=dv[types["blue"]](r*ro+offs["blue"],true);
      }
      rgba[3]=types["opacity"]?1/(1+Math.exp(-dv[types["opacity"]](r*ro+offs["opacity"],true)))*255:255;
    }
    return out;
  }
});
