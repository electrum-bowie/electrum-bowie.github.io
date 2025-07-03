AFRAME.registerComponent("gaussian_splatting", {
  schema: {
    src: { type: 'string', default: "" },
    pixelRatio: { type: 'number', default: 0.8 },
    xrPixelRatio: { type: 'number', default: 0.8 },
    foveation: { type: 'number', default: 1.0 },
    minXrPixelRatio: { type: 'number', default: 0.4 },
    maxXrPixelRatio: { type: 'number', default: 1.1 },
    targetFramerate: { type: 'number', default: 60 },
  },
  init: function () {
    const pixelRatio = this.data.pixelRatio < 0 ? window.devicePixelRatio : this.data.pixelRatio;
    const xrPixelRatio = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
    this.el.sceneEl.renderer.setPixelRatio(pixelRatio);
    this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(xrPixelRatio);
    this.currentXrPixelRatio = xrPixelRatio;
    this.minXrPixelRatio = this.data.minXrPixelRatio;
    this.maxXrPixelRatio = this.data.maxXrPixelRatio;
    this.targetFramerate = this.data.targetFramerate;
    this._frameCount = 0;
    this._frameTime = 0;
    const gl = this.el.sceneEl.renderer.getContext();
    gl.disable(gl.DITHER);
    this.originalBuffers = [];
    this.needsQualityUpdate = false;
    this.initGL(this.el.sceneEl.camera.el.components.camera.camera, this.el.object3D, this.el.sceneEl.renderer);
    this.loadData(this.data.src);
    this.el.sceneEl.renderer.xr.addEventListener("sessionstart", async () => {
      const gl = this.el.sceneEl.renderer.getContext();
      if (gl.makeXRCompatible) {
        try { await gl.makeXRCompatible(); } catch (e) { console.warn("makeXRCompatible failed", e); }
      }
      const ext = gl.getExtension("OVR_multiview2") || gl.getExtension("OVR_multiview") || gl.getExtension("OCULUS_multiview") || gl.getExtension("WEBGL_multiview");
      if (ext && this.el.sceneEl.renderer.xr.setMultiviewEnabled) {
        this.el.sceneEl.renderer.xr.setMultiviewEnabled(true);
      }
      const session = this.el.sceneEl.renderer.xr.getSession?.();
      if (session && session.updateTargetFrameRate) {
        try { await session.updateTargetFrameRate(60); } catch (e) { console.warn('Failed to set target FPS', e); }
      }
      this.applyFoveationLevel();
      this.currentXrPixelRatio = this.data.xrPixelRatio;
      this.updateXRScale();
    });
    this.el.sceneEl.renderer.xr.addEventListener("sessionend", () => {
      this.applyFoveationLevel();
      this.currentXrPixelRatio = this.data.xrPixelRatio;
      this.updateXRScale();
    });
    this.el.sceneEl.addEventListener("enter-vr", () => {
      this.applyFoveationLevel();
      this.currentXrPixelRatio = this.data.xrPixelRatio;
      this.updateXRScale();
    });
    this.el.sceneEl.addEventListener("exit-vr", () => {
      this.applyFoveationLevel();
      this.currentXrPixelRatio = this.data.xrPixelRatio;
      this.updateXRScale();
    });
  },
  initGL: function (camera, object, renderer) {
    this.camera = camera;
    this.object = object;
    this.renderer = renderer;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.textureReady = false;
    this.object.frustumCulled = false;
    this.lastCameraMatrix = new THREE.Matrix4(); this.lastCameraMatrix.identity();
    this.lastObjectMatrix = new THREE.Matrix4(); this.lastObjectMatrix.identity();
    this.lastScale = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastCameraPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastCameraQuat = new THREE.Quaternion(0, 0, 0, 0);
    this.lastObjectPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastObjectQuat = new THREE.Quaternion(0, 0, 0, 0);
    this.tmpCameraPos = new THREE.Vector3();
    this.tmpCameraQuat = new THREE.Quaternion();
    this.viewRotationMatrix = new THREE.Matrix3();
    this.centerAndScaleData = new Float32Array(4096 * 4096 * 4);
    this.covAndColorData = new Uint32Array(4096 * 4096 * 4);
    this.centerAndScaleTexture = new THREE.DataTexture(this.centerAndScaleData, 4096, 4096, THREE.RGBA, THREE.FloatType);
    this.centerAndScaleTexture.generateMipmaps = false;
    this.centerAndScaleTexture.minFilter = THREE.NearestFilter;
    this.centerAndScaleTexture.magFilter = THREE.NearestFilter;
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture = new THREE.DataTexture(this.covAndColorData, 4096, 4096, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    this.covAndColorTexture.generateMipmaps = false;
    this.covAndColorTexture.minFilter = THREE.NearestFilter;
    this.covAndColorTexture.magFilter = THREE.NearestFilter;
    this.covAndColorTexture.internalFormat = "RGBA32UI";
    this.covAndColorTexture.needsUpdate = true;
    let splatIndexArray = new Uint32Array(4096 * 4096);
    const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
    splatIndexes.setUsage(THREE.DynamicDrawUsage);
    const baseGeometry = new THREE.BufferGeometry();
    const positionsArray = new Float32Array(6 * 3);
    const positions = new THREE.BufferAttribute(positionsArray, 3);
    baseGeometry.setAttribute('position', positions);
    positions.setXYZ(2, -2.0, 2.0, 0.0);
    positions.setXYZ(1, 2.0, 2.0, 0.0);
    positions.setXYZ(0, -2.0, -2.0, 0.0);
    positions.setXYZ(5, -2.0, -2.0, 0.0);
    positions.setXYZ(4, 2.0, 2.0, 0.0);
    positions.setXYZ(3, 2.0, -2.0, 0.0);
    positions.needsUpdate = true;
    const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);
    geometry.setAttribute('splatIndex', splatIndexes);
    geometry.instanceCount = 1;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        viewport: { value: new Float32Array([1980, 1080]) },
        viewportInv: { value: new Float32Array([1.0, 1.0]) },
        focal: { value: 1000.0 },
        centerAndScaleTexture: { value: this.centerAndScaleTexture },
        covAndColorTexture: { value: this.covAndColorTexture },
        gsProjectionMatrix: { value: this.getProjectionMatrix() },
        gsModelViewMatrix: { value: this.getModelViewMatrix() },
        viewRotationMatrix: { value: new THREE.Matrix3() },
      },
      vertexShader: `
precision highp usampler2D;
out vec4 vColor;
out vec2 vPosition;
uniform vec2 viewport;
uniform vec2 viewportInv;
uniform float focal;
uniform mat4 gsProjectionMatrix;
uniform mat4 gsModelViewMatrix;
uniform mat3 viewRotationMatrix;
attribute uint splatIndex;
uniform sampler2D centerAndScaleTexture;
uniform usampler2D covAndColorTexture;
vec2 unpackInt16(in uint value) {
  int v = int(value);
  int v0 = v >> 16;
  int v1 = (v & 0xFFFF);
  if((v & 0x8000) != 0) v1 |= 0xFFFF0000;
  return vec2(float(v1), float(v0));
}
void main () {
  ivec2 texPos = ivec2(int(splatIndex & 4095u), int(splatIndex >> 12));
  vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);
  vec4 center = vec4(centerAndScaleData.xyz, 1);
  vec4 camspace = gsModelViewMatrix * center;
  vec4 pos2d = gsProjectionMatrix * camspace;
  uvec4 covAndColorData = texelFetch(covAndColorTexture, texPos, 0);
  vec2 cov3D_M11_M12 = unpackInt16(covAndColorData.x) * centerAndScaleData.w;
  vec2 cov3D_M13_M22 = unpackInt16(covAndColorData.y) * centerAndScaleData.w;
  vec2 cov3D_M23_M33 = unpackInt16(covAndColorData.z) * centerAndScaleData.w;
  mat3 Vrk = mat3(
    cov3D_M11_M12.x, cov3D_M11_M12.y, cov3D_M13_M22.x,
    cov3D_M11_M12.y, cov3D_M13_M22.y, cov3D_M23_M33.x,
    cov3D_M13_M22.x, cov3D_M23_M33.x, cov3D_M23_M33.y
  );
  float invZ = 1.0 / camspace.z;
  float invZ2 = invZ * invZ;
  mat3 J = mat3(
    focal * invZ, 0., -focal * camspace.x * invZ2,
    0., -focal * invZ, focal * camspace.y * invZ2,
    0., 0., 0.
  );
  mat3 W = viewRotationMatrix;
  mat3 T = W * J;
  mat3 cov = transpose(T) * Vrk * T;
  float invPosW = 1.0 / pos2d.w;
  vec2 vCenter = pos2d.xy * invPosW;
  float diagonal1 = cov[0][0] + 0.3;
  float offDiagonal = cov[0][1];
  float diagonal2 = cov[1][1] + 0.3;
  float mid = 0.5 * (diagonal1 + diagonal2);
  float radius = length(vec2((diagonal1 - diagonal2) / 2.0, offDiagonal));
  float lambda1 = mid + radius;
  float lambda2 = max(mid - radius, 0.1);
  vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
  vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
  vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);
  uint colorUint = covAndColorData.w;
  const vec4 inv255 = vec4(0.003921569);
  vColor = vec4(
    float(colorUint & 0xFFu),
    float((colorUint >> 8) & 0xFFu),
    float((colorUint >> 16) & 0xFFu),
    float(colorUint >> 24)
  ) * inv255;
  vPosition = position.xy;
  gl_Position = vec4(
    vCenter + (position.x * v2 + position.y * v1) * viewportInv,
    pos2d.z * invPosW, 1.0
  );
}
`,
      fragmentShader: `
in vec4 vColor;
in vec2 vPosition;
void main () {
  float len2 = dot(vPosition, vPosition);
  if (len2 > 4.0) discard;
  float B = exp(-len2) * vColor.a;
  gl_FragColor = vec4(vColor.rgb, B);
}
`,
      blending: THREE.CustomBlending,
      blendSrcAlpha: THREE.OneFactor,
      depthTest: true,
      depthWrite: false,
      transparent: true
    });
    material.dithering = false;
    material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
      let projectionMatrix = this.getProjectionMatrix(camera);
      material.uniforms.gsProjectionMatrix.value = projectionMatrix;
      let viewMatrix = this.getModelViewMatrix(camera);
      material.uniforms.gsModelViewMatrix.value = viewMatrix;
      this.viewRotationMatrix.setFromMatrix4(viewMatrix).transpose();
      material.uniforms.viewRotationMatrix.value.copy(this.viewRotationMatrix);
      let viewport = new THREE.Vector4();
      renderer.getCurrentViewport(viewport);
      let focal = (viewport.w / 2.0) * Math.abs(projectionMatrix.elements[5]);
      material.uniforms.viewport.value[0] = viewport.z;
      material.uniforms.viewport.value[1] = viewport.w;
      material.uniforms.viewportInv.value[0] = 2.0 / viewport.z;
      material.uniforms.viewportInv.value[1] = 2.0 / viewport.w;
      material.uniforms.focal.value = focal;
    };
    let mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.object.add(mesh);
    this.mesh = mesh;
    this.workerMatrices = null;
    this.lastBasicIndices = null;
    this.lastOcclusionVisibleIndices = null;
    this.basicReady = true;
    this.occlusionReady = true;
    const blobCode = ["(", this.createWorker.toString(), ")(self)"].join("");
    this.basicWorker = new Worker(URL.createObjectURL(new Blob([blobCode], { type: "application/javascript" })));
    this.occlusionWorker = new Worker(URL.createObjectURL(new Blob([blobCode], { type: "application/javascript" })));
    this.basicWorker.onmessage = (e) => {
      let bi = new Uint32Array(e.data.basicIndices);
      this.lastBasicIndices = bi;
      this.basicReady = true;
      this.applyCombinedVisible();
    };
    this.occlusionWorker.onmessage = (e) => {
      let oi = new Uint32Array(e.data.occlusionIndices);
      this.lastOcclusionVisibleIndices = oi;
      this.occlusionReady = true;
      this.applyCombinedVisible();
    };
  },
  loadData: function (src) {
    this.loadedVertexCount = 0;
    this.rowLength = 3 * 4 + 3 * 4 + 4 + 4;
    this.basicWorker.postMessage({ method: "clear" });
    this.occlusionWorker.postMessage({ method: "clear" });
    this.originalBuffers = [];
    this.isCaching = true;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    fetch(src).then(async (data) => {
      const reader = data.body.getReader();
      let bytesDownloaded = 0, bytesProcesses = 0;
      let _total = data.headers.get("Content-Length");
      let totalDownloadBytes = _total ? parseInt(_total) : undefined;
      const chunks = [];
      const start = Date.now();
      let lastReportedProgress = 0;
      let isPly = true;
      while (true) {
        try {
          const { value, done } = await reader.read();
          if (done) break;
          bytesDownloaded += value.length;
          if (totalDownloadBytes != undefined) {
            const mbps = (bytesDownloaded / 1024 / 1024) / ((Date.now() - start) / 1000);
            const percent = bytesDownloaded / totalDownloadBytes * 100;
            if (percent - lastReportedProgress > 1) lastReportedProgress = percent;
          }
          chunks.push(value);
          if (!this.textureReady &&
            this.renderer.properties.get(this.centerAndScaleTexture) &&
            this.renderer.properties.get(this.covAndColorTexture)) {
            this.textureReady = true;
          }
          const bytesRemains = bytesDownloaded - bytesProcesses;
          if (!isPly && this.textureReady && bytesRemains > this.rowLength) {
            let vertexCount = Math.floor(bytesRemains / this.rowLength);
            const bufRem = new Uint8Array(bytesRemains);
            let off = 0;
            for (const c of chunks) { bufRem.set(c, off); off += c.length; }
            chunks.length = 0;
            if (bytesRemains > vertexCount * this.rowLength) {
              const extra = new Uint8Array(bytesRemains - vertexCount * this.rowLength);
              extra.set(bufRem.subarray(bufRem.length - extra.length), 0);
              chunks.push(extra);
            }
            const buffer = new Uint8Array(vertexCount * this.rowLength);
            buffer.set(bufRem.subarray(0, buffer.byteLength), 0);
            this.pushDataBuffer(buffer.buffer, vertexCount);
            bytesProcesses += vertexCount * this.rowLength;
          }
        } catch { break; }
      }
      if (bytesDownloaded - bytesProcesses > 0) {
        let concat = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
        let of = 0;
        for (const c of chunks) { concat.set(c, of); of += c.length; }
        if (isPly) concat = new Uint8Array(this.processPlyBuffer(concat.buffer));
        this.pushDataBuffer(concat.buffer, Math.floor(concat.byteLength / this.rowLength));
      }
    }).finally(() => {
      this.isCaching = false;
      if (this.needsQualityUpdate) {
        this.needsQualityUpdate = false;
        this.updateQuality();
      }
      this.triggerCulling();
    });
  },
  pushDataBuffer: function (buffer, vertexCount) {
    if (this.loadedVertexCount + vertexCount > 4096 * 4096) {
      vertexCount = 4096 * 4096 - this.loadedVertexCount;
    }
    if (vertexCount <= 0) return;
    if (this.isCaching) this.originalBuffers.push(buffer.slice(0));
    const slider = document.getElementById("slider");
    let sliderValue = 1;
    if (slider) {
      const min = parseFloat(slider.min), max = parseFloat(slider.max);
      sliderValue = parseFloat(slider.value);
      window.latestSliderValue = sliderValue;
      sliderValue = min + max - sliderValue;
    } else if (typeof window.latestSliderValue === 'number') {
      sliderValue = window.latestSliderValue;
    }
    let vc = vertexCount / (isNaN(sliderValue) ? 1 : sliderValue);
    let u_buf = new Uint8Array(buffer);
    let f_buf = new Float32Array(buffer);
    let matrices = new Float32Array(vc * 16);
    const covUint8 = new Uint8Array(this.covAndColorData.buffer);
    const covInt16 = new Int16Array(this.covAndColorData.buffer);
    let count = 0;
    for (let i = 0; i < vc; i++) {
      let quat = new THREE.Quaternion(
        (u_buf[32 * i + 29] - 128) / 128.0,
        (u_buf[32 * i + 30] - 128) / 128.0,
        -(u_buf[32 * i + 31] - 128) / 128.0,
        (u_buf[32 * i + 28] - 128) / 128.0,
      );
      let center = new THREE.Vector3(
        f_buf[8 * i + 0],
        f_buf[8 * i + 1],
        -f_buf[8 * i + 2]
      );
      let scale = new THREE.Vector3(
        f_buf[8 * i + 3 + 0],
        f_buf[8 * i + 3 + 1],
        f_buf[8 * i + 3 + 2]
      );
      const maxScale = 100.0, minScale = 0.0001;
      if (Math.max(scale.x, scale.y, scale.z) > maxScale ||
        Math.max(scale.x, scale.y, scale.z) < minScale) continue;
      let mtx = new THREE.Matrix4();
      mtx.makeRotationFromQuaternion(quat);
      mtx.transpose();
      mtx.scale(scale);
      let mtx_t = mtx.clone(); mtx.transpose(); mtx.premultiply(mtx_t);
      mtx.setPosition(center);
      let covIdx = [0,1,2,5,6,10];
      let maxv = 0.0;
      for (let j = 0; j < covIdx.length; j++) {
        maxv = Math.max(maxv, Math.abs(mtx.elements[covIdx[j]]));
      }
      let dest = this.loadedVertexCount * 4 + count * 4;
      this.centerAndScaleData[dest+0] = center.x;
      this.centerAndScaleData[dest+1] = center.y;
      this.centerAndScaleData[dest+2] = center.z;
      this.centerAndScaleData[dest+3] = maxv / 32767.0;
      dest = this.loadedVertexCount * 8 + count * 8;
      for (let j = 0; j < covIdx.length; j++) {
        covInt16[dest+j] = parseInt(mtx.elements[covIdx[j]] * 32767.0 / maxv);
      }
      dest = this.loadedVertexCount * 16 + (count * 4 + 3) * 4;
      covUint8[dest+0] = u_buf[32*i+24+0];
      covUint8[dest+1] = u_buf[32*i+24+1];
      covUint8[dest+2] = u_buf[32*i+24+2];
      covUint8[dest+3] = u_buf[32*i+24+3];
      mtx.elements[15] = Math.max(scale.x, scale.y, scale.z);
      mtx.elements[11] = u_buf[32*i+24+3]/255.0;
      for (let j = 0; j < 16; j++) matrices[count*16+j] = mtx.elements[j];
      count++;
    }
    while (count>0) {
      let xoff = this.loadedVertexCount%4096;
      let yoff = Math.floor(this.loadedVertexCount/4096);
      let width, height;
      if (xoff!=0) {
        width = Math.min(4096, xoff+count)-xoff; height=1;
      } else if (Math.floor(count/4096)>0) {
        width=4096; height=Math.floor(count/4096);
      } else { width = count%4096; height=1; }
      const gl = this.renderer.getContext();
      const propCS = this.renderer.properties.get(this.centerAndScaleTexture);
      gl.bindTexture(gl.TEXTURE_2D, propCS.__webglTexture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,xoff,yoff,width,height,gl.RGBA,gl.FLOAT,this.centerAndScaleData,this.loadedVertexCount*4);
      const propCC = this.renderer.properties.get(this.covAndColorTexture);
      gl.bindTexture(gl.TEXTURE_2D, propCC.__webglTexture);
      gl.texSubImage2D(gl.TEXTURE_2D,0,xoff,yoff,width,height,gl.RGBA_INTEGER,gl.UNSIGNED_INT,this.covAndColorData,this.loadedVertexCount*4);
      this.loadedVertexCount += width*height;
      count -= width*height;
    }
    this.workerMatrices = matrices.buffer;
    this.basicWorker.postMessage({ method: "push", matrices: matrices.buffer }, [matrices.buffer]);
    this.occlusionWorker.postMessage({ method: "push", matrices: matrices.buffer }, [matrices.buffer]);
  },
  tick: function (time, timeDelta) {
    this.camera.getWorldPosition(this.tmpCameraPos);
    const camPosChanged = this.tmpCameraPos.distanceToSquared(this.lastCameraPos)>0.001;
    this.camera.getWorldQuaternion(this.tmpCameraQuat);
    const camRotChanged = 2*Math.acos(Math.min(1,Math.abs(this.tmpCameraQuat.dot(this.lastCameraQuat))))>0.008;
    const objPosChanged = this.object.position.distanceToSquared(this.lastObjectPos)>1e-6;
    const objRotChanged = 2*Math.acos(Math.min(1,Math.abs(this.object.quaternion.dot(this.lastObjectQuat))))>0.001;
    const scaleChanged = this.object.scale.distanceToSquared(this.lastScale)>1e-6;
    if ((camPosChanged||camRotChanged||objPosChanged||objRotChanged||scaleChanged)) this.triggerCulling();
    if (this.el.sceneEl.is('vr-mode')||this.el.sceneEl.renderer.xr.isPresenting) {
      this._frameCount++; this._frameTime+=timeDelta;
      if (this._frameTime>=1000) {
        const fps=1000*this._frameCount/this._frameTime;
        if (fps<this.targetFramerate&&this.currentXrPixelRatio>this.minXrPixelRatio) {
          this.currentXrPixelRatio=Math.max(this.minXrPixelRatio,this.currentXrPixelRatio-0.05);
          this.updateXRScale();
        } else if (fps>this.targetFramerate&&this.currentXrPixelRatio<this.maxXrPixelRatio) {
          this.currentXrPixelRatio=Math.min(this.maxXrPixelRatio,this.currentXrPixelRatio+0.05);
          this.updateXRScale();
        }
        this._frameCount=0; this._frameTime=0;
      }
    }
  },
  updateQuality: function () {
    if (this.isCaching) {
      if (this.originalBuffers.length>0) this.needsQualityUpdate=true;
      return;
    }
    if (!this.originalBuffers||this.originalBuffers.length===0) return;
    this.loadedVertexCount=0;
    if (this.mesh&&this.mesh.geometry) this.mesh.geometry.instanceCount=0;
    this.basicWorker.postMessage({method:"clear"});
    this.occlusionWorker.postMessage({method:"clear"});
    this.centerAndScaleTexture.needsUpdate=true;
    this.covAndColorTexture.needsUpdate=true;
    for (const buf of this.originalBuffers) this.pushDataBuffer(buf.slice(0), buf.byteLength/this.rowLength);
    this.triggerCulling();
  },
  applyFoveationLevel: function () {
    const renderer=this.el.sceneEl.renderer;
    const session=renderer.xr.getSession?.();
    const level=this.data.foveation;
    if (session&&session.renderState&&session.renderState.baseLayer) {
      const baseLayer=session.renderState.baseLayer;
      if (baseLayer&&'fixedFoveation' in baseLayer) {
        try{baseLayer.fixedFoveation=level;}catch(e){}
        return;
      }
    }
    if (renderer.xr.setFoveation) {
      try{renderer.xr.setFoveation(level);}catch(e){}
    }
  },
  updateXRScale: function () {
    const renderer=this.el.sceneEl.renderer;
    const session=renderer.xr.getSession?.();
    if (session&&typeof XRWebGLLayer!=="undefined") {
      try{
        const camera=renderer.xr.getCamera?.();
        if(camera&&camera.views){
          for(const view of camera.views){
            if(view.requestViewportScale) view.requestViewportScale(this.currentXrPixelRatio);
          }
        }
      }catch(e){}
    } else {
      renderer.xr.setFramebufferScaleFactor(this.currentXrPixelRatio);
    }
  },
  triggerCulling: function () {
    if (!this.workerMatrices) return;
    this.basicReady=false; this.occlusionReady=false;
    const viewMatrix=this.getModelViewMatrix();
    const projMatrix=this.getProjectionMatrix();
    const cm=viewMatrix.elements;
    const view=new Float32Array([cm[2],cm[6],cm[10],cm[14]]);
    const mvpMatrix=new THREE.Matrix4().multiplyMatrices(projMatrix,viewMatrix);
    const mvp=new Float32Array(mvpMatrix.elements);
    const globalScale=Math.max(this.object.scale.x,this.object.scale.y,this.object.scale.z);
    const sliderValue=typeof window.latestSliderValue==='number'?window.latestSliderValue:1;
    const vp=new THREE.Vector4(); this.renderer.getCurrentViewport(vp);
    const focal=(vp.w/2.0)*Math.abs(projMatrix.elements[5]);
    this.basicWorker.postMessage({ method:"basicCull", matrices:this.workerMatrices, view:view.buffer, mvp:mvp.buffer, scale:globalScale, sliderValue:sliderValue, focal:focal }, [view.buffer,mvp.buffer]);
    let bi=this.lastBasicIndices?new Uint32Array(this.lastBasicIndices):null;
    if (bi) {
      let buf=new Uint32Array(bi);
      this.occlusionWorker.postMessage({ method:"occlusionSort", matrices:this.workerMatrices, basicIndices:buf.buffer, view:view.buffer, mvp:mvp.buffer, scale:globalScale, sliderValue:sliderValue, focal:focal }, [buf.buffer,view.buffer,mvp.buffer]);
    } else {
      this.occlusionWorker.postMessage({ method:"occlusionSort", matrices:this.workerMatrices, view:view.buffer, mvp:mvp.buffer, scale:globalScale, sliderValue:sliderValue, focal:focal }, [view.buffer,mvp.buffer]);
    }
    this.lastCameraMatrix.copy(this.camera.matrixWorld);
    this.lastObjectMatrix.copy(this.object.matrixWorld);
    this.lastScale.copy(this.object.scale);
    this.camera.getWorldPosition(this.lastCameraPos);
    this.camera.getWorldQuaternion(this.lastCameraQuat);
    this.lastObjectPos.copy(this.object.position);
    this.lastObjectQuat.copy(this.object.quaternion);
  },
  applyCombinedVisible: function () {
    if (!this.basicReady||!this.occlusionReady) return;
    if (!this.lastBasicIndices||!this.lastOcclusionVisibleIndices) return;
    const basicSet=new Set(this.lastBasicIndices);
    const finalList=[];
    for(const i of this.lastOcclusionVisibleIndices) if(basicSet.has(i)) finalList.push(i);
    const arr=new Uint32Array(finalList);
    this.mesh.geometry.attributes.splatIndex.set(arr);
    this.mesh.geometry.attributes.splatIndex.needsUpdate=true;
    this.mesh.geometry.instanceCount=arr.length;
  },
  getProjectionMatrix: function(camera) {
    if(!camera) camera=this.camera;
    let m=camera.projectionMatrix.clone();
    m.elements[4]*=-1; m.elements[5]*=-1; m.elements[6]*=-1; m.elements[7]*=-1;
    return m;
  },
  getModelViewMatrix: function(camera) {
    if(!camera) camera=this.camera;
    const vm=camera.matrixWorld.clone();
    vm.elements[1]*=-1; vm.elements[4]*=-1; vm.elements[6]*=-1; vm.elements[9]*=-1; vm.elements[13]*=-1;
    const m=this.object.matrixWorld.clone();
    m.invert();
    m.elements[1]*=-1; m.elements[4]*=-1; m.elements[6]*=-1; m.elements[9]*=-1; m.elements[13]*=-1;
    m.multiply(vm);
    m.invert();
    return m;
  },
  matricesEqual: function(a,b,epsilon=1e-3){
    for(let i=0;i<16;i++) if(Math.abs(a.elements[i]-b.elements[i])>epsilon) return false;
    return true;
  },
  createWorker: function(self){
    let matrices;
    function basicCull(mats,view,mvp,scaleFactor,sliderValue,focal){
      const vertexCount=mats.length/16;
      const sizeThreshold=0.00001*(isNaN(sliderValue)?1:sliderValue);
      const valid=new Uint32Array(vertexCount);
      let validCount=0;
      const nearPlaneClip=-0.19;
      for(let i=0;i<vertexCount;i++){
        const px=mats[i*16+12],py=mats[i*16+13],pz=mats[i*16+14];
        const clip_x=mvp[0]*px+mvp[4]*py+mvp[8]*pz+mvp[12];
        const clip_y=mvp[1]*px+mvp[5]*py+mvp[9]*pz+mvp[13];
        const clip_z=mvp[2]*px+mvp[6]*py+mvp[10]*pz+mvp[14];
        const clip_w=mvp[3]*px+mvp[7]*py+mvp[11]*pz+mvp[15];
        const radius=mats[i*16+15]*scaleFactor;
        const transparency=mats[i*16+11];
        const prod=radius*transparency;
        const skipCull=(prod/scaleFactor)>1.0;
        if(!skipCull&&(clip_w<=0||clip_z<=-clip_w)) continue;
        const invW=1.0/clip_w;
        const ndcX=clip_x*invW,ndcY=clip_y*invW,ndcZ=clip_z*invW;
        if(!skipCull&&(ndcZ<-1.0||ndcZ>1.0||ndcX<-1.0||ndcX>1.0||ndcY<-1.0||ndcY>1.0)) continue;
        const depth=view[0]*px+view[1]*py+view[2]*pz+view[3];
        if(prod<sizeThreshold) continue;
        if(!skipCull&&(depth+radius>nearPlaneClip)) continue;
        const edgeDist=Math.max(Math.abs(ndcX),Math.abs(ndcY));
        const edgeMul=1.0+(edgeDist*0.5);
        const pixelRadius=focal*prod/(-depth);
        if(pixelRadius<0.9*edgeMul&&!skipCull) continue;
        valid[validCount++]=i;
      }
      return valid.slice(0,validCount);
    }
    function occlusionSort(mats,basicIndices,view,mvp,scaleFactor){
      const indices=basicIndices||new Uint32Array(mats.length/16).map((_,i)=>i);
      const vc=indices.length;
      let maxDepth=-Infinity,minDepth=Infinity;
      const depthList=new Float32Array(vc);
      for(let j=0;j<vc;j++){
        const i=indices[j];
        const depth=view[0]*mats[i*16+12]+view[1]*mats[i*16+13]+view[2]*mats[i*16+14]+view[3];
        depthList[j]=depth;
        if(depth>maxDepth) maxDepth=depth;
        if(depth<minDepth) minDepth=depth;
      }
      const depthInv=(256*256-1)/(maxDepth-minDepth);
      const sizeList=new Int32Array(depthList.buffer);
      const counts=new Uint32Array(256*256);
      for(let i=0;i<vc;i++){
        const v=(depthList[i]-minDepth)*depthInv|0;
        sizeList[i]=v;
        counts[v]++;
      }
      const starts=new Uint32Array(256*256);
      for(let i=1;i<256*256;i++) starts[i]=starts[i-1]+counts[i-1];
      const depthIndex=new Uint32Array(vc);
      for(let i=0;i<vc;i++) depthIndex[starts[sizeList[i]]++]=indices[i];
      const gridSize=256;
      const coverage=new Float32Array(gridSize*gridSize);
      const tmpVisible=new Uint32Array(vc);
      let visibleCount=0;
      for(let j=depthIndex.length-1;j>=0;j--){
        const i=depthIndex[j];
        const px=mats[i*16+12],py=mats[i*16+13],pz=mats[i*16+14];
        const clip_x=mvp[0]*px+mvp[4]*py+mvp[8]*pz+mvp[12];
        const clip_y=mvp[1]*px+mvp[5]*py+mvp[9]*pz+mvp[13];
        const clip_z=mvp[2]*px+mvp[6]*py+mvp[10]*pz+mvp[14];
        const clip_w=mvp[3]*px+mvp[7]*py+mvp[11]*pz+mvp[15];
        if(clip_w<=0){ tmpVisible[visibleCount++]=i; continue; }
        const invW=1.0/clip_w;
        const ndcX=clip_x*invW,ndcY=clip_y*invW,ndcZ=clip_z*invW;
        if(ndcZ<-1.0||ndcZ>1.0||ndcX<-1.0||ndcX>1.0||ndcY<-1.0||ndcY>1.0){
          tmpVisible[visibleCount++]=i; continue;
        }
        const opacity=mats[i*16+11];
        const depth=view[0]*px+view[1]*py+view[2]*pz+view[3];
        const radius=mats[i*16+15]*scaleFactor;
        const r=(Math.abs(radius/depth))*gridSize*0.5;
        const cx=(ndcX*0.5+0.5)*gridSize;
        const cy=(ndcY*0.5+0.5)*gridSize;
        let totalW=0,occW=0;
        const minX=Math.max(0,Math.floor(cx-r)),maxX=Math.min(gridSize-1,Math.ceil(cx+r));
        const minY=Math.max(0,Math.floor(cy-r)),maxY=Math.min(gridSize-1,Math.ceil(cy+r));
        const r2=r*r;
        for(let y=minY;y<=maxY;y++){
          for(let x=minX;x<=maxX;x++){
            const dx=x+0.5-cx,dy=y+0.5-cy;
            const norm=(dx*dx+dy*dy)/r2;
            if(norm>1.0) continue;
            const w=Math.exp(-norm);
            totalW+=w;
            occW+=coverage[y*gridSize+x]*w;
          }
        }
        if(totalW===0||1-(occW/totalW)>0.01){
          tmpVisible[visibleCount++]=i;
          for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
              const dx=x+0.5-cx,dy=y+0.5-cy;
              const norm=(dx*dx+dy*dy)/r2;
              if(norm>1.0) continue;
              const w=Math.exp(-norm);
              const idx2=y*gridSize+x;
              const alphaContrib=w*(opacity*opacity*opacity*opacity);
              coverage[idx2]=coverage[idx2]+(1-coverage[idx2])*alphaContrib;
            }
          }
        }
      }
      const result=new Uint32Array(visibleCount);
      for(let i=0;i<visibleCount;i++) result[i]=tmpVisible[visibleCount-1-i];
      return result;
    }
    self.onmessage = (e) => {
      if(e.data.method=="clear"){ matrices=undefined; }
      if(e.data.method=="push"){
        const new_m=new Float32Array(e.data.matrices);
        if(!matrices) { matrices=new_m; }
        else {
          const r=new Float32Array(matrices.length+new_m.length);
          r.set(matrices);
          r.set(new_m,matrices.length);
          matrices=r;
        }
      }
      if(e.data.method=="basicCull"){
        const mats=new Float32Array(e.data.matrices);
        const view=new Float32Array(e.data.view);
        const mvp=new Float32Array(e.data.mvp);
        const bi=basicCull(mats,view,mvp,e.data.scale,e.data.sliderValue,e.data.focal);
        self.postMessage({ basicIndices: bi }, [bi.buffer]);
      }
      if(e.data.method=="occlusionSort"){
        const mats=new Float32Array(e.data.matrices);
        const view=new Float32Array(e.data.view);
        const mvp=new Float32Array(e.data.mvp);
        const bi=e.data.basicIndices?new Uint32Array(e.data.basicIndices):null;
        const oi=occlusionSort(mats,bi,view,mvp,e.data.scale,e.data.sliderValue);
        self.postMessage({ occlusionIndices: oi }, [oi.buffer]);
      }
    };
  },
  processPlyBuffer: function(inputBuffer) {
    const ubuf=new Uint8Array(inputBuffer);
    const header=new TextDecoder().decode(ubuf.slice(0,1024*10));
    const header_end="end_header\n";
    const idx=header.indexOf(header_end);
    if(idx<0) throw new Error("Unable to read .ply file header");
    const vertexCount=parseInt(/element vertex (\d+)\n/.exec(header)[1]);
    let row_offset=0,offsets={},types={};
    const TYPE_MAP={double:"getFloat64",int:"getInt32",uint:"getUint32",float:"getFloat32",short:"getInt16",ushort:"getUint16",uchar:"getUint8"};
    for(const prop of header.slice(0,idx).split("\n").filter(k=>k.startsWith("property "))){
      const [p,type,name]=prop.split(" ");
      const arrayType=TYPE_MAP[type]||"getInt8";
      types[name]=arrayType;
      offsets[name]=row_offset;
      row_offset+=parseInt(arrayType.replace(/[^\d]/g,""))/8;
    }
    let dataView=new DataView(inputBuffer,idx+header_end.length);
    let row=0;
    const attrs=new Proxy({},{
      get(target,prop){
        if(!types[prop]) throw new Error(prop+" not found");
        return dataView[types[prop]](row*row_offset+offsets[prop],true);
      }
    });
    let sizeList=new Float32Array(vertexCount);
    let sizeIndex=new Uint32Array(vertexCount);
    for(row=0;row<vertexCount;row++){
      sizeIndex[row]=row;
      if(types["scale_0"]) {
        const size=Math.exp(attrs.scale_0)*Math.exp(attrs.scale_1)*Math.exp(attrs.scale_2);
        const opacity=1/(1+Math.exp(-attrs.opacity));
        sizeList[row]=size*opacity;
      }
    }
    sizeIndex.sort((b,a)=>sizeList[a]-sizeList[b]);
    const rowLength=3*4+3*4+4+4;
    const buffer=new ArrayBuffer(rowLength*vertexCount);
    for(let j=0;j<vertexCount;j++){
      row=sizeIndex[j];
      const position=new Float32Array(buffer,j*rowLength,3);
      const scales=new Float32Array(buffer,j*rowLength+3*4,3);
      const rgba=new Uint8ClampedArray(buffer,j*rowLength+3*4+3*4,4);
      const rot=new Uint8ClampedArray(buffer,j*rowLength+3*4+3*4+4,4);
      if(types["scale_0"]) {
        const qlen=Math.sqrt(attrs.rot_0**2+attrs.rot_1**2+attrs.rot_2**2+attrs.rot_3**2);
        rot[0]=attrs.rot_0/qlen*128+128;
        rot[1]=attrs.rot_1/qlen*128+128;
        rot[2]=attrs.rot_2/qlen*128+128;
        rot[3]=attrs.rot_3/qlen*128+128;
        scales[0]=Math.exp(attrs.scale_0);
        scales[1]=Math.exp(attrs.scale_1);
        scales[2]=Math.exp(attrs.scale_2);
      } else {
        scales[0]=0.01; scales[1]=0.01; scales[2]=0.01;
        rot[0]=255; rot[1]=0; rot[2]=0; rot[3]=0;
      }
      position[0]=attrs.x; position[1]=attrs.y; position[2]=attrs.z;
      if(types["f_dc_0"]) {
        const SH_C0=0.28209479177387814;
        rgba[0]=(0.5+SH_C0*attrs.f_dc_0)*255;
        rgba[1]=(0.5+SH_C0*attrs.f_dc_1)*255;
        rgba[2]=(0.5+SH_C0*attrs.f_dc_2)*255;
      } else {
        rgba[0]=attrs.red; rgba[1]=attrs.green; rgba[2]=attrs.blue;
      }
      if(types["opacity"]) rgba[3]=(1/(1+Math.exp(-attrs.opacity)))*255;
      else rgba[3]=255;
    }
    return buffer;
  }
});