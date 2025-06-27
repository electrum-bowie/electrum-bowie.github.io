AFRAME.registerComponent("gaussian_splatting", {
        schema: {
                src:         { type: "string",  default: ""   },
                pixelRatio:  { type: "number",  default: 0.5  },
                xrPixelRatio:{ type: "number",  default: 0.9  },
                foveation:   { type: "number",  default: 3.0  }
        },

        init: function () {
                /* ---------- scene / renderer initial-isation ---------- */
                const pixelRatio   = this.data.pixelRatio  < 0 ? window.devicePixelRatio : this.data.pixelRatio;
                const xrPixelRatio = this.data.xrPixelRatio< 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
                this.el.sceneEl.renderer.setPixelRatio(pixelRatio);
                this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(xrPixelRatio);

                this.originalBuffers   = [];
                this.needsQualityUpdate = false;

                this.initGL(this.el.sceneEl.camera.el.components.camera.camera,
                            this.el.object3D,
                            this.el.sceneEl.renderer);
                this.loadData(this.data.src);

                /* ---------- XR session hooks ---------- */
                this.el.sceneEl.renderer.xr.addEventListener("sessionstart", async () => {
                        const gl = this.el.sceneEl.renderer.getContext();
                        if (gl.makeXRCompatible) {
                                try { await gl.makeXRCompatible(); }
                                catch (e) { console.warn("makeXRCompatible failed", e); }
                        }
                        const ext = gl.getExtension("OVR_multiview2") ||
                                    gl.getExtension("OVR_multiview")  ||
                                    gl.getExtension("OCULUS_multiview") ||
                                    gl.getExtension("WEBGL_multiview");
                        if (ext && this.el.sceneEl.renderer.xr.setMultiviewEnabled) {
                                this.el.sceneEl.renderer.xr.setMultiviewEnabled(true);
                                console.log("Multiview enabled");
                        } else {
                                console.log("Multiview not supported");
                        }

                        const session = this.el.sceneEl.renderer.xr.getSession?.();
                        const level   = this.data.foveation;
                        if (session && session.renderState && session.renderState.baseLayer) {
                                const baseLayer = session.renderState.baseLayer;
                                if (baseLayer && "fixedFoveation" in baseLayer) {
                                        baseLayer.fixedFoveation = level;
                                        console.log("Fixed foveated rendering set to", level);
                                } else if (this.el.sceneEl.renderer.xr.setFoveation) {
                                        this.el.sceneEl.renderer.xr.setFoveation(level);
                                        console.log("Fixed foveated rendering set to", level);
                                } else {
                                        console.log("Fixed foveated rendering not supported");
                                }
                        }
                });
        },

        /* ================================================================
         *  OpenGL / Three.js initial-isation
         * ================================================================ */
        initGL: function (camera, object, renderer) {
                this.camera        = camera;
                this.object        = object;
                this.renderer      = renderer;
                this.textureReady  = false;
                this.object.frustumCulled = false;

                /* ------ textures that hold packed splat data ------ */
                this.centerAndScaleData = new Float32Array(4096 * 4096 * 4);
                this.covAndColorData    = new Uint32Array(4096 * 4096 * 4);
                this.centerAndScaleTexture = new THREE.DataTexture(
                        this.centerAndScaleData, 4096, 4096, THREE.RGBA, THREE.FloatType);
                this.centerAndScaleTexture.needsUpdate = true;

                this.covAndColorTexture = new THREE.DataTexture(
                        this.covAndColorData, 4096, 4096,
                        THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
                this.covAndColorTexture.internalFormat = "RGBA32UI";
                this.covAndColorTexture.needsUpdate = true;

                /* ------ instanced geometry / attributes ------ */
                let splatIndexArray = new Uint32Array(4096 * 4096);
                const splatIndexes  = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
                splatIndexes.setUsage(THREE.DynamicDrawUsage);

                const baseGeometry = new THREE.BufferGeometry();
                const positionsArray = new Float32Array(6 * 3);
                const positions = new THREE.BufferAttribute(positionsArray, 3);
                baseGeometry.setAttribute("position", positions);

                /* two-triangle quad (clip-space) */
                positions.setXYZ(2, -2.0,  2.0, 0.0);
                positions.setXYZ(1,  2.0,  2.0, 0.0);
                positions.setXYZ(0, -2.0, -2.0, 0.0);
                positions.setXYZ(5, -2.0, -2.0, 0.0);
                positions.setXYZ(4,  2.0,  2.0, 0.0);
                positions.setXYZ(3,  2.0, -2.0, 0.0);
                positions.needsUpdate = true;

                const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);
                geometry.setAttribute("splatIndex", splatIndexes);
                geometry.instanceCount = 1;

                /* ========================================================
                 *  ShaderMaterial   (premultiplied-RGB version)
                 * ======================================================== */
                const material = new THREE.ShaderMaterial({
                        uniforms: {
                                viewport:             { value: new Float32Array([1980, 1080]) },
                                focal:                { value: 1000.0 },
                                centerAndScaleTexture:{ value: this.centerAndScaleTexture },
                                covAndColorTexture:   { value: this.covAndColorTexture },
                                gsProjectionMatrix:   { value: this.getProjectionMatrix() },
                                gsModelViewMatrix:    { value: this.getModelViewMatrix() }
                        },

                        vertexShader: `
                                precision highp usampler2D;

                                out vec4 vColor;
                                out vec2 vPosition;

                                uniform vec2  viewport;
                                uniform float focal;
                                uniform mat4  gsProjectionMatrix;
                                uniform mat4  gsModelViewMatrix;

                                attribute uint splatIndex;
                                uniform sampler2D  centerAndScaleTexture;
                                uniform usampler2D covAndColorTexture;

                                vec2 unpackInt16(uint value) {
                                        int v = int(value);
                                        int v0 =  v >> 16;
                                        int v1 = (v & 0xFFFF);
                                        if ((v & 0x8000) != 0) v1 |= 0xFFFF0000;
                                        return vec2(float(v1), float(v0));
                                }

                                void main () {
                                        ivec2 texPos = ivec2(splatIndex % uint(4096), splatIndex / uint(4096));

                                        vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);

                                        /* camera-space transform */
                                        vec4 center   = vec4(centerAndScaleData.xyz, 1.0);
                                        vec4 camspace = gsModelViewMatrix * center;
                                        vec4 pos2d    = gsProjectionMatrix * camspace;

                                        /* trivial reject (bounding box in clip space) */
                                        float bounds = 2.0 * pos2d.w;
                                        if (pos2d.z < -pos2d.w ||
                                            pos2d.x < -bounds || pos2d.x > bounds ||
                                            pos2d.y < -bounds || pos2d.y > bounds) {
                                                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                                                return;
                                        }

                                        /* unpack cov + colour */
                                        uvec4 covAndColorData  = texelFetch(covAndColorTexture, texPos, 0);
                                        vec2 cov3D_M11_M12     = unpackInt16(covAndColorData.x) * centerAndScaleData.w;
                                        vec2 cov3D_M13_M22     = unpackInt16(covAndColorData.y) * centerAndScaleData.w;
                                        vec2 cov3D_M23_M33     = unpackInt16(covAndColorData.z) * centerAndScaleData.w;
                                        mat3 Vrk = mat3(
                                                 cov3D_M11_M12.x, cov3D_M11_M12.y, cov3D_M13_M22.x,
                                                 cov3D_M11_M12.y, cov3D_M13_M22.y, cov3D_M23_M33.x,
                                                 cov3D_M13_M22.x, cov3D_M23_M33.x, cov3D_M23_M33.y );

                                        mat3 J = mat3(
                                                 focal / camspace.z, 0.0, -(focal * camspace.x) / (camspace.z*camspace.z),
                                                 0.0, -focal / camspace.z, (focal * camspace.y) / (camspace.z*camspace.z),
                                                 0.0, 0.0, 0.0 );

                                        mat3 W   = transpose(mat3(gsModelViewMatrix));
                                        mat3 T   = W * J;
                                        mat3 cov = transpose(T) * Vrk * T;

                                        vec2 vCenter = vec2(pos2d) / pos2d.w;

                                        /* eigen-analysis (2×2) */
                                        float d1  = cov[0][0] + 0.3;
                                        float od  = cov[0][1];
                                        float d2  = cov[1][1] + 0.3;

                                        float mid     = 0.5 * (d1 + d2);
                                        float radius  = length(vec2((d1 - d2)/2.0, od));
                                        float lambda1 = mid + radius;
                                        float lambda2 = max(mid - radius, 0.1);

                                        vec2  diagVec = normalize(vec2(od, lambda1 - d1));
                                        vec2  v1      = min(sqrt(2.0 * lambda1), 1024.0) * diagVec;
                                        vec2  v2      = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagVec.y, -diagVec.x);

                                        /* colour */
                                        uint colorUint  = covAndColorData.w;
                                        vColor = vec4(
                                                float(colorUint &          0xFFu) / 255.0,
                                                float((colorUint >>  8u) & 0xFFu) / 255.0,
                                                float((colorUint >> 16u) & 0xFFu) / 255.0,
                                                float((colorUint >> 24u)       ) / 255.0 );

                                        vPosition = position.xy;

                                        gl_Position = vec4(
                                                vCenter
                                                + position.x * v2 / viewport * 2.0
                                                + position.y * v1 / viewport * 2.0,
                                                pos2d.z / pos2d.w, 1.0);
                                }
                        `,

                        /* ── fragment shader ── */
                        fragmentShader: `
                                in  vec4 vColor;
                                in  vec2 vPosition;

                                void main () {
                                        float A = -dot(vPosition, vPosition);
                                        if (A < -4.0) discard;

                                        float B = exp(A) * vColor.a;          // Gaussian weight * opacity

                                        /*  premultiplied-RGB output  */
                                        gl_FragColor = vec4(vColor.rgb * B, B);
                                }
                        `,

                        transparent: true,
                        depthTest:   true,
                        depthWrite:  false,

                        /* -----------------------------------------------------------------
                         *  PREMULTIPLIED-RGB BLENDING STATE
                         *  RGB: src = ONE (already multiplied by alpha)
                         *       dst = ONE_MINUS_SRC_ALPHA
                         *  A  : src = ONE
                         *       dst = ONE_MINUS_SRC_ALPHA
                         * ----------------------------------------------------------------- */
                        blending:       THREE.CustomBlending,
                        blendEquation:  THREE.AddEquation,

                        blendSrc:       THREE.OneFactor,
                        blendDst:       THREE.OneMinusSrcAlphaFactor,
                        blendSrcAlpha:  THREE.OneFactor,
                        blendDstAlpha:  THREE.OneMinusSrcAlphaFactor
                });

                /* onBeforeRender – update uniforms every frame */
                material.onBeforeRender = ((renderer, scene, camera, geometry, object, group) => {
                        /* projection / model-view */
                        let proj = this.getProjectionMatrix(camera);
                        mesh.material.uniforms.gsProjectionMatrix.value  = proj;
                        mesh.material.uniforms.gsModelViewMatrix.value   = this.getModelViewMatrix(camera);

                        /* viewport-dependent focal length */
                        let vp = new THREE.Vector4();
                        renderer.getCurrentViewport(vp);
                        const focal = (vp.w / 2.0) * Math.abs(proj.elements[5]);
                        material.uniforms.viewport.value[0] = vp.z;
                        material.uniforms.viewport.value[1] = vp.w;
                        material.uniforms.focal.value       = focal;

                        /* (optional) re-apply XR scale if runtimes change it */
                        // renderer.xr.setFramebufferScaleFactor(this.data.xrPixelRatio);
                });

                /* ------ build mesh ------ */
                mesh = new THREE.Mesh(geometry, material);
                mesh.frustumCulled = false;
                this.object.add(mesh);

                /* worker for depth-sort */
                this.worker = new Worker(
                        URL.createObjectURL(new Blob(["(", this.createWorker.toString(), ")(self)"],
                                                     { type: "application/javascript" })));

                this.worker.onmessage = (e) => {
                        let indexes = new Uint32Array(e.data.sortedIndexes);
                        mesh.geometry.attributes.splatIndex.set(indexes);
                        mesh.geometry.attributes.splatIndex.needsUpdate = true;
                        mesh.geometry.instanceCount = indexes.length;
                        this.sortReady = true;
                };
                this.sortReady = true;

  loadData(src) {
    this.loadedVertexCount = 0;
    this.rowLength = 3*4 + 3*4 + 4 + 4; // as before
    this.worker.postMessage({ method: "clear" });
    this.originalBuffers = [];
    this.isCaching = true;

    fetch(src)
      .then(async data => {
        const reader = data.body.getReader();
        let bytesDownloaded = 0, bytesProcessed = 0;
        const totalBytes = parseInt(data.headers.get("Content-Length")) || undefined;
        const chunks = [];
        const start = Date.now();
        let lastProg = 0;
        const isPly = src.toLowerCase().endsWith(".ply");

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesDownloaded += value.length;
          if (totalBytes) {
            const pct = bytesDownloaded/totalBytes*100;
            if (pct - lastProg > 1) {
              const mbps = (bytesDownloaded/1024/1024)/((Date.now()-start)/1000);
              console.log(`progress: ${pct.toFixed(2)}% ${mbps.toFixed(2)}Mbps`);
              lastProg = pct;
            }
          }
          chunks.push(value);

          if (!this.textureReady &&
              this.renderer.properties.get(this.centerAndScaleTexture) &&
              this.renderer.properties.get(this.covAndColorTexture)) {
            this.textureReady = true;
          }

          const rem = bytesDownloaded - bytesProcessed;
          if (!isPly && this.textureReady && rem > this.rowLength) {
            const vcount = Math.floor(rem / this.rowLength);
            const concat = new Uint8Array(rem);
            let off = 0;
            for (let c of chunks) { concat.set(c, off); off += c.length; }
            chunks.length = 0;
            const buf = concat.subarray(0, vcount*this.rowLength);
            this.pushDataBuffer(buf.buffer, vcount);
            bytesProcessed += vcount*this.rowLength;
            const leftover = concat.subarray(vcount*this.rowLength);
            if (leftover.length) chunks.push(leftover);
          }
        }

        // final tail
        const remTail = bytesDownloaded - bytesProcessed;
        if (remTail > 0) {
          let concat = new Uint8Array(chunks.reduce((a,b)=>a+b.length,0));
          let off = 0;
          for (let c of chunks) { concat.set(c,off); off+=c.length; }
          let buffer = concat.buffer;
          if (isPly) buffer = this.processPlyBuffer(buffer);
          this.pushDataBuffer(buffer, Math.floor(buffer.byteLength/this.rowLength));
        }
      })
      .finally(() => {
        this.isCaching = false;
        if (this.needsQualityUpdate) {
          this.needsQualityUpdate = false;
          this.updateQuality();
        }
      });
  },

  pushDataBuffer(buffer, vertexCount) {
    if (this.loadedVertexCount + vertexCount > 4096*4096) {
      vertexCount = 4096*4096 - this.loadedVertexCount;
    }
    if (vertexCount <= 0) return;
    if (this.isCaching) this.originalBuffers.push(buffer.slice(0));

    // quality slider logic unchanged…

    const u8 = new Uint8Array(buffer);
    const f32 = new Float32Array(buffer);
    const matrices = new Float32Array(vertexCount * 16);
    const covUint8  = new Uint8Array(this.covAndColorData.buffer);
    const covInt16  = new Int16Array(this.covAndColorData.buffer);

    for (let i = 0; i < vertexCount; i++) {
      const qx = (u8[32*i+29]-128)/128,
            qy = (u8[32*i+30]-128)/128,
            qz =-(u8[32*i+31]-128)/128,
            qw = (u8[32*i+28]-128)/128;
      const quat = new THREE.Quaternion(qx,qy,qz,qw);
      const center = new THREE.Vector3(f32[8*i], f32[8*i+1], -f32[8*i+2]);
      const scale  = new THREE.Vector3(
        f32[8*i+3], f32[8*i+4], f32[8*i+5]
      );
      const maxScale = 9.0, minScale = 0.002;
      if (Math.max(scale.x,scale.y,scale.z)>maxScale||Math.max(scale.x,scale.y,scale.z)<minScale) continue;

      let mtx = new THREE.Matrix4().makeRotationFromQuaternion(quat);
      mtx.transpose().scale(scale);
      const mtx_t = mtx.clone(); mtx_t.transpose();
      mtx.premultiply(mtx_t).setPosition(center);

      const covIdxs = [0,1,2,5,6,10];
      let mmax = 0;
      for (let j=0;j<covIdxs.length;j++){
        mmax = Math.max(mmax, Math.abs(mtx.elements[covIdxs[j]]));
      }
      const csVal = mmax/32767.0;

      let baseOff = this.loadedVertexCount*4 + i*4;
      this.centerAndScaleData[baseOff  ] = center.x;
      this.centerAndScaleData[baseOff+1] = center.y;
      this.centerAndScaleData[baseOff+2] = center.z;
      this.centerAndScaleData[baseOff+3] = csVal;

      baseOff = this.loadedVertexCount*8 + i*8;
      for (let j=0;j<covIdxs.length;j++){
        covInt16[baseOff+j] = parseInt(mtx.elements[covIdxs[j]]*32767.0/mmax);
      }

      // color
      baseOff = this.loadedVertexCount*16 + (i*4+3)*4;
      covUint8[baseOff  ] = u8[32*i+24];
      covUint8[baseOff+1] = u8[32*i+25];
      covUint8[baseOff+2] = u8[32*i+26];
      covUint8[baseOff+3] = u8[32*i+27];

      // sorting key
      mtx.elements[15] = Math.max(scale.x,scale.y,scale.z)*u8[32*i+27]/255.0;

      for (let j=0;j<16;j++){
        matrices[i*16+j] = mtx.elements[j];
      }
    }

    const gl = this.renderer.getContext();
    let remaining = vertexCount;
    while (remaining > 0) {
      const xoff = this.loadedVertexCount % 4096;
      const yoff = Math.floor(this.loadedVertexCount/4096);
      let width, height;
      if (xoff !== 0) {
        width  = Math.min(4096, xoff+remaining) - xoff;
        height = 1;
      } else if (remaining >= 4096) {
        width  = 4096;
        height = Math.floor(remaining/4096);
      } else {
        width  = remaining;
        height = 1;
      }

      const cenTexProps = this.renderer.properties.get(this.centerAndScaleTexture);
      gl.bindTexture(gl.TEXTURE_2D, cenTexProps.__webglTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        xoff, yoff, width, height,
        gl.RGBA, gl.FLOAT,
        this.centerAndScaleData, this.loadedVertexCount*4
      );

      const covTexProps = this.renderer.properties.get(this.covAndColorTexture);
      gl.bindTexture(gl.TEXTURE_2D, covTexProps.__webglTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        xoff, yoff, width, height,
        gl.RGBA_INTEGER, gl.UNSIGNED_INT,
        this.covAndColorData, this.loadedVertexCount*4
      );

      this.loadedVertexCount += width*height;
      remaining -= width*height;
    }

    this.worker.postMessage(
      { method:"push", matrices:matrices.buffer },
      [matrices.buffer]
    );
  },

  tick(time, timeDelta) {
    if (!this.sortReady) return;
    this.sortReady = false;
    const me = this.getModelViewMatrix();
    const view = new Float32Array([me.elements[2], me.elements[6], me.elements[10], me.elements[14]]);
    const scale = Math.max(this.object.scale.x, this.object.scale.y, this.object.scale.z);
    this.worker.postMessage(
      { method:"sort", view:view.buffer, scale },
      [view.buffer]
    );
  },

  updateQuality() {
    if (this.isCaching) {
      this.needsQualityUpdate = this.originalBuffers?.length > 0;
      return;
    }
    if (!this.originalBuffers?.length) return;
    this.loadedVertexCount = 0;
    this.worker.postMessage({ method:"clear" });
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture.needsUpdate    = true;

    for (const buf of this.originalBuffers) {
      this.pushDataBuffer(buf, buf.byteLength/this.rowLength);
    }
    this.sortReady = true;
  },

  getProjectionMatrix(camera) {
    if (!camera) camera = this.camera;
    const m = camera.projectionMatrix.clone();
    m.elements[4] *= -1;
    m.elements[5] *= -1;
    m.elements[6] *= -1;
    m.elements[7] *= -1;
    return m;
  },

  getModelViewMatrix(camera) {
    if (!camera) camera = this.camera;
    const vM = camera.matrixWorld.clone();
    vM.elements[1] *= -1;
    vM.elements[4] *= -1;
    vM.elements[6] *= -1;
    vM.elements[9] *= -1;
    vM.elements[13]*= -1;
    const m = this.object.matrixWorld.clone().invert();
    m.elements[1] *= -1; m.elements[4] *= -1; m.elements[6] *= -1;
    m.elements[9] *= -1; m.elements[13]*= -1;
    m.multiply(vM).invert();
    return m;
  },

  createWorker(self) {
    let matrices;
    function sortSplats(mats, view, scale=1){
      const vc = mats.length/16;
      let maxD=-Infinity, minD=Infinity;
      const depths = new Float32Array(vc), idxs=new Int32Array(vc);
      let count=0;
      for (let i=0; i<vc; i++){
        const d = view[0]*mats[i*16+12] + view[1]*mats[i*16+13] +
                  view[2]*mats[i*16+14] + view[3];
        if (d<0 && mats[i*16+15]*scale > -0.001*d){
          depths[count]=d;
          idxs[count]=i;
          maxD = Math.max(maxD,d);
          minD = Math.min(minD,d);
          count++;
        }
      }
      const inv = (256*256-1)/(maxD-minD);
      const hist = new Uint32Array(256*256), start = new Uint32Array(256*256);
      const keys = new Int32Array(count);
      for (let i=0;i<count;i++){
        const k = ((depths[i]-minD)*inv)|0;
        keys[i]=k; hist[k]++;
      }
      for (let i=1;i<256*256;i++) start[i]=start[i-1]+hist[i-1];
      const sorted = new Uint32Array(count);
      for (let i=0;i<count;i++){
        sorted[start[keys[i]]++] = idxs[i];
      }
      return sorted;
    }

    self.onmessage = (e) => {
      if (e.data.method==="clear") {
        matrices = undefined;
      } else if (e.data.method==="push") {
        const newM = new Float32Array(e.data.matrices);
        matrices = matrices ? (Float32Array.of(...matrices, ...newM)) : newM;
      } else if (e.data.method==="sort") {
        if (!matrices) {
          const single = new Uint32Array([0]);
          self.postMessage({ sortedIndexes: single.buffer }, [single.buffer]);
        } else {
          const view = new Float32Array(e.data.view);
          const sorted = sortSplats(matrices, view, e.data.scale);
          self.postMessage({ sortedIndexes: sorted.buffer }, [sorted.buffer]);
        }
      }
    };
  },

  processPlyBuffer(inputBuffer) {
    const ubuf = new Uint8Array(inputBuffer);
    const header = new TextDecoder().decode(ubuf.slice(0,10*1024));
    const endIdx = header.indexOf("end_header\n");
    if (endIdx<0) throw new Error("PLY header missing");
    const vcount = parseInt(/element vertex (\d+)/.exec(header)[1]);
    const TYPE_MAP = {
      double:"getFloat64", float:"getFloat32",
      int:"getInt32", uint:"getUint32",
      short:"getInt16", ushort:"getUint16",
      uchar:"getUint8"
    };
    let rowOff=0, offsets={}, types={};
    header.slice(0,endIdx).split("\n").forEach(line=>{
      if (!line.startsWith("property ")) return;
      const [_,t,n]=line.split(" ");
      types[n]=TYPE_MAP[t]||"getInt8";
      offsets[n]=rowOff;
      rowOff += parseInt(types[n].match(/\d+/)[0])/8;
    });
    const dv = new DataView(inputBuffer,endIdx+"end_header\n".length);
    const attrs = new Proxy({},{
      get(_,p){
        if (!types[p]) throw new Error(p+" missing");
        return dv[types[p]](rowOff*row + offsets[p],true);
      }
    });

    const sizeList = new Float32Array(vcount);
    const indexList = new Uint32Array(vcount);
    for (let i=0;i<vcount;i++){
      indexList[i]=i;
      if (!types.scale_0) continue;
      const size = Math.exp(attrs.scale_0)*Math.exp(attrs.scale_1)*Math.exp(attrs.scale_2);
      const opac = 1/(1+Math.exp(-attrs.opacity));
      sizeList[i]=size*opac;
    }
    indexList.sort((a,b)=>sizeList[b]-sizeList[a]);

    const rowLen = rowOff;
    const out = new ArrayBuffer(rowLen*vcount);
    for (let j=0;j<vcount;j++){
      const i = indexList[j];
      const pos = new Float32Array(out,j*rowLen,3);
      const sc  = new Float32Array(out,j*rowLen+12,3);
      const col = new Uint8ClampedArray(out,j*rowLen+24,4);
      const rot = new Uint8ClampedArray(out,j*rowLen+28,4);

      if (types.scale_0){
        const qlen = Math.hypot(attrs.rot_0,attrs.rot_1,attrs.rot_2,attrs.rot_3);
        rot[0]=(attrs.rot_0/qlen)*128+128;
        rot[1]=(attrs.rot_1/qlen)*128+128;
        rot[2]=(attrs.rot_2/qlen)*128+128;
        rot[3]=(attrs.rot_3/qlen)*128+128;
        sc[0]=Math.exp(attrs.scale_0);
        sc[1]=Math.exp(attrs.scale_1);
        sc[2]=Math.exp(attrs.scale_2);
      } else {
        sc[0]=sc[1]=sc[2]=0.01;
        rot.set([255,0,0,0]);
      }

      pos[0]=attrs.x; pos[1]=attrs.y; pos[2]=attrs.z;
      if (types.f_dc_0){
        const C0=0.28209479177387814;
        col[0]=(0.5+C0*attrs.f_dc_0)*255;
        col[1]=(0.5+C0*attrs.f_dc_1)*255;
        col[2]=(0.5+C0*attrs.f_dc_2)*255;
      } else {
        col[0]=attrs.red; col[1]=attrs.green; col[2]=attrs.blue;
      }
      col[3]= types.opacity
             ? (1/(1+Math.exp(-attrs.opacity)))*255
             : 255;
    }

    return out;
  }
});