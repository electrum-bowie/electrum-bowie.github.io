AFRAME.registerComponent('gaussian_splatting', {
  schema: {
    src:        { type: 'string', default: '' },
    pixelRatio: { type: 'number', default: 0.5 },
    xrPixelRatio:{ type: 'number', default: 0.7 },
    foveation:  { type: 'number', default: 3.0 }
  },

  init() {
    // --------- Renderer & XR setup ---------
    const pr       = this.data.pixelRatio < 0 ? window.devicePixelRatio : this.data.pixelRatio;
    const xrPr     = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
    const renderer = this.el.sceneEl.renderer;
    renderer.setPixelRatio(pr);
    renderer.xr.setFramebufferScaleFactor(xrPr);
    const gl = renderer.getContext();
    gl.disable(gl.DITHER);

    // --------- State ---------
    this.originalBuffers   = [];
    this.textureReady      = false;
    this.sortReady         = true;
    this.needsQualityUpdate= false;

    // --------- Initialize GL, Textures, Geometry, Shader, Worker, etc ---------
    this.initGL(
      this.el.sceneEl.camera.el.components.camera.camera,
      this.el.object3D,
      renderer
    );
    this.loadData(this.data.src);

    // --------- XR Session Listener (multiview + foveation) ---------
    renderer.xr.addEventListener('sessionstart', async () => {
      if (gl.makeXRCompatible) {
        try { await gl.makeXRCompatible(); }
        catch (e) { console.warn('makeXRCompatible failed', e); }
      }
      const ext = (
        gl.getExtension('OVR_multiview2') ||
        gl.getExtension('OVR_multiview')  ||
        gl.getExtension('OCULUS_multiview') ||
        gl.getExtension('WEBGL_multiview')
      );
      if (ext && renderer.xr.setMultiviewEnabled) {
        renderer.xr.setMultiviewEnabled(true);
        console.log('Multiview enabled');
      }
      const session = renderer.xr.getSession?.();
      if (session?.renderState?.baseLayer) {
        const base = session.renderState.baseLayer;
        if ('fixedFoveation' in base) {
          base.fixedFoveation = this.data.foveation;
        } else if (renderer.xr.setFoveation) {
          renderer.xr.setFoveation(this.data.foveation);
        }
        console.log('Foveation level:', this.data.foveation);
      }
    });
  },

  initGL(camera, object3D, renderer) {
    this.camera   = camera;
    this.object3D = object3D;
    this.renderer = renderer;

    // Ensure correct color space
    if (renderer.outputColorSpace !== undefined) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if (renderer.outputEncoding !== undefined) {
      renderer.outputEncoding   = THREE.sRGBEncoding;
    }

    // Disable frustum culling on parent
    object3D.frustumCulled = false;

    // Pre-allocate full atlas (4096² splats)
    const ATLAS_SIZE   = 4096;
    const MAX_SPLATS   = ATLAS_SIZE * ATLAS_SIZE;
    const TEXELS       = MAX_SPLATS * 4;

    // Typed arrays for textures
    this.centerAndScaleData    = new Float32Array(TEXELS);
    this.covAndColorData       = new Uint32Array(TEXELS);
    this.centerAndScaleTexture = new THREE.DataTexture(
      this.centerAndScaleData, ATLAS_SIZE, ATLAS_SIZE,
      THREE.RGBAFormat, THREE.FloatType
    );
    this.covAndColorTexture    = new THREE.DataTexture(
      this.covAndColorData, ATLAS_SIZE, ATLAS_SIZE,
      THREE.RGBAIntegerFormat, THREE.UnsignedIntType
    );
    this.covAndColorTexture.internalFormat = 'RGBA32UI';
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture.needsUpdate    = true;

    // Pre-views on covAndColor buffer
    this._covUint8  = new Uint8Array(this.covAndColorData.buffer);
    this._covInt16  = new Int16Array(this.covAndColorData.buffer);

    // Instanced geometry for single quad
    const baseGeo = new THREE.BufferGeometry();
    const posArr  = new Float32Array([
      -2, -2, 0,   -2,  2, 0,    2,  2, 0,
      -2, -2, 0,    2,  2, 0,    2, -2, 0
    ]);
    baseGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    const instGeo = new THREE.InstancedBufferGeometry().copy(baseGeo);
    this._splatIndexArr = new Uint32Array(MAX_SPLATS);
    instGeo.setAttribute(
      'splatIndex',
      new THREE.InstancedBufferAttribute(this._splatIndexArr, 1).setUsage(THREE.DynamicDrawUsage)
    );
    instGeo.instanceCount = 0;  // start empty

    // Shader material
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        viewport: { value: new Float32Array([1,1]) },
        focal:    { value: 1.0 },
        centerAndScaleTexture: { value: this.centerAndScaleTexture },
        covAndColorTexture:    { value: this.covAndColorTexture },
        gsProjectionMatrix:    { value: new THREE.Matrix4() },
        gsModelViewMatrix:     { value: new THREE.Matrix4() }
      },
      vertexShader: /* glsl */`
        precision highp usampler2D;
        in uint splatIndex;
        uniform vec2 viewport;
        uniform float focal;
        uniform mat4 gsProjectionMatrix, gsModelViewMatrix;
        uniform sampler2D centerAndScaleTexture;
        uniform usampler2D covAndColorTexture;
        out vec4 vColor;
        out vec2 vPosition;

        vec2 unpackInt16(uint v) {
          int hi = int(v >> 16);
          int lo = int(v & 0xFFFF);
          if ((v & 0x8000u) != 0u) lo |= 0xFFFF0000;
          return vec2(float(lo), float(hi));
        }

        void main() {
          ivec2 tc = ivec2(splatIndex % 4096u, splatIndex / 4096u);
          vec4 cs   = texelFetch(centerAndScaleTexture, tc, 0);
          vec4 ctr  = vec4(cs.xyz,1.0);
          vec4 cam  = gsModelViewMatrix * ctr;
          vec4 proj = gsProjectionMatrix   * cam;

          uvec4 cc  = texelFetch(covAndColorTexture, tc, 0);
          float scaleW = cs.w;
          vec2 m11m12 = unpackInt16(cc.x) * scaleW;
          vec2 m13m22 = unpackInt16(cc.y) * scaleW;
          vec2 m23m33 = unpackInt16(cc.z) * scaleW;
          mat3 V    = mat3(
            m11m12.x, m11m12.y, m13m22.x,
            m11m12.y, m13m22.y, m23m33.x,
            m13m22.x, m23m33.x, m23m33.y
          );
          mat3 J    = mat3(
            focal/cam.z,0.,-(focal*cam.x)/(cam.z*cam.z),
            0.,-focal/cam.z,(focal*cam.y)/(cam.z*cam.z),
            0.,0.,0.
          );
          mat3 W    = transpose(mat3(gsModelViewMatrix));
          mat3 T    = W * J;
          mat3 cov  = transpose(T)*V*T;

          vec2 center2D = (proj.xy / proj.w);

          float d1 = cov[0][0] + 0.3;
          float o  = cov[0][1];
          float d2 = cov[1][1] + 0.3;
          float mid = 0.5*(d1+d2);
          float r  = length(vec2((d1-d2)*0.5, o));
          float l1 = mid + r;
          float l2 = max(mid - r, 0.1);
          vec2 dv = normalize(vec2(o, l1 - d1));
          vec2 v1 = min(sqrt(2.*l1),1024.) * dv;
          vec2 v2 = min(sqrt(2.*l2),1024.) * vec2(dv.y, -dv.x);

          uint cu = cc.w;
          vColor = vec4(
            float(cu & 0xFFu)/255.,
            float((cu>>8u) & 0xFFu)/255.,
            float((cu>>16u)&0xFFu)/255.,
            float(cu>>24u)/255.
          );

          vPosition = position.xy;
          gl_Position = vec4(
            center2D +
              v2 * position.x * 2.0/viewport +
              v1 * position.y * 2.0/viewport,
            proj.z / proj.w,
            1.0
          );
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec4 vColor;
        in vec2 vPosition;
        void main() {
          float A = -dot(vPosition, vPosition);
          if (A < -4.0) discard;
          float alpha = exp(A) * vColor.a;
          gl_FragColor = vec4(vColor.rgb, alpha);
        }
      `,
      blending: THREE.CustomBlending,
      blendSrcAlpha: THREE.OneFactor,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      dithering: false
    });

    // Cache for onBeforeRender
    const mesh = new THREE.Mesh(instGeo, mat);
    mesh.frustumCulled = false;
    object3D.add(mesh);

    mat.onBeforeRender = (renderer, scene, camera) => {
      const vp = new THREE.Vector4();
      renderer.getCurrentViewport(vp);
      const pm = this.getProjectionMatrix(camera);
      const vm = this.getModelViewMatrix(camera);
      mat.uniforms.gsProjectionMatrix.value.copy(pm);
      mat.uniforms.gsModelViewMatrix.value.copy(vm);

      const focal = (vp.w/2) * Math.abs(pm.elements[5]);
      mat.uniforms.viewport.value[0] = vp.z;
      mat.uniforms.viewport.value[1] = vp.w;
      mat.uniforms.focal.value       = focal;
    };

    // Prepare worker
    this.worker = new Worker(URL.createObjectURL(new Blob([
      '(', this.createWorker.toString(), ')(self)'
    ], { type: 'application/javascript'})));

    this.worker.onmessage = (e) => {
      const idx = new Uint32Array(e.data.sortedIndexes);
      instGeo.attributes.splatIndex.array.set(idx);
      instGeo.attributes.splatIndex.needsUpdate = true;
      instGeo.instanceCount = idx.length;
      this.sortReady = true;
    };
  },

  loadData(src) {
    this.loadedVertexCount = 0;
    this.rowLength = 3*4 + 3*4 + 4 + 4;
    this.worker.postMessage({ method: 'clear' });
    this.originalBuffers = [];
    this.isCaching = true;

    fetch(src).then(async res => {
      const reader = res.body.getReader();
      const totalBytes = parseInt(res.headers.get('Content-Length')) || undefined;
      const chunks = [];
      let downloaded = 0, processed = 0;
      const start = Date.now();
      let lastPct = 0, isPly = true;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        downloaded += value.length;
        if (totalBytes) {
          const pct = downloaded/totalBytes*100;
          if (pct - lastPct > 1) {
            const mbps = (downloaded/1024/1024)/((Date.now()-start)/1000);
            console.log(`Progress: ${pct.toFixed(1)}% @ ${mbps.toFixed(2)}MB/s`);
            lastPct = pct;
          }
        } else {
          console.log('Downloaded bytes:', downloaded);
        }
        chunks.push(value);
        if (!this.textureReady &&
            this.renderer.properties.get(this.centerAndScaleTexture) &&
            this.renderer.properties.get(this.covAndColorTexture)
        ) {
          this.textureReady = true;
        }

        // Process buffered data
        const rem = downloaded - processed;
        if (!isPly && this.textureReady && rem > this.rowLength) {
          const vc = Math.floor(rem/this.rowLength);
          const buf = new Uint8Array(vc*this.rowLength);
          let off=0;
          for(const c of chunks) {
            buf.set(c, off);
            off += c.length;
          }
          chunks.length = 0;
          // leftover
          const left = downloaded - processed - buf.byteLength;
          if (left>0) {
            const tail = new Uint8Array(left);
            tail.set(buf.subarray(buf.byteLength - left));
            chunks.push(tail);
          }
          this.pushDataBuffer(buf.buffer, vc);
          processed += buf.byteLength;
        }
      }

      // final flush
      const remBytes = downloaded - processed;
      if (remBytes > 0) {
        let finalBuf = new Uint8Array(remBytes), off=0;
        for(const c of chunks) {
          finalBuf.set(c, off);
          off += c.length;
        }
        const toPush = isPly
          ? new Uint8Array(this.processPlyBuffer(finalBuf.buffer))
          : finalBuf;
        this.pushDataBuffer(toPush.buffer, Math.floor(toPush.byteLength/this.rowLength));
      }
    }).finally(() => {
      this.isCaching = false;
      if (this.needsQualityUpdate) {
        this.needsQualityUpdate = false;
        this.updateQuality();
      }
    });
  },

  pushDataBuffer(buffer, vertexCount) {
    // clamp to atlas
    const ATLAS_SIZE = 4096;
    const MAX_SPLATS = ATLAS_SIZE*ATLAS_SIZE;
    if (this.loadedVertexCount + vertexCount > MAX_SPLATS) {
      vertexCount = MAX_SPLATS - this.loadedVertexCount;
    }
    if (vertexCount <= 0) return;

    // Cache original for quality slider
    if (this.isCaching) this.originalBuffers.push(buffer.slice(0));

    // Slider factor
    let slider = window.latestSliderValue ?? 1;
    const sEl = document.getElementById('slider');
    if (sEl) {
      const min = +sEl.min, max = +sEl.max, v = +sEl.value;
      slider = min + max - v;
      window.latestSliderValue = slider;
    }
    const invFactor = isNaN(slider)?1:slider;
    vertexCount = Math.floor(vertexCount/invFactor);

    // Typed views on incoming buffer
    const u8 = new Uint8Array(buffer);
    const f32= new Float32Array(buffer);

    // Reusable temps
    const q = new THREE.Quaternion();
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const mt = new THREE.Matrix4();

    // Build matrices and populate textures
    const mats = new Float32Array(vertexCount*16);
    for (let i=0, vi=0; i<vertexCount; i++) {
      // decode quaternion
      const base = 32*i;
      q.set(
        (u8[base+29]-128)/128,
        (u8[base+30]-128)/128,
        -(u8[base+31]-128)/128,
        (u8[base+28]-128)/128
      );
      // center & scale
      c.set(f32[8*i], f32[8*i+1], -f32[8*i+2]);
      s.set(f32[8*i+3], f32[8*i+4], f32[8*i+5]);
      const maxS = Math.max(s.x,s.y,s.z);
      if (maxS>9||maxS<0.002) continue;

      m.identity().makeRotationFromQuaternion(q).transpose().scale(s);
      mt.copy(m).transpose();
      m.premultiply(mt);
      m.setPosition(c);

      // covariance entries
      const ci = this.loadedVertexCount*8 + i*8;
      const idxs = [0,1,2,5,6,10];
      let mmax = 0;
      for (const idx of idxs) mmax = Math.max(mmax, Math.abs(m.elements[idx]));
      const norm = mmax/32767;
      for (let j=0; j<6; j++) {
        this._covInt16[ci+j] = Math.round(m.elements[idxs[j]]/norm);
      }

      // color + alpha
      const co = 32*i+24, cd = this._covUint8;
      cd[this.loadedVertexCount*16 + (i*4+0)] = u8[co];
      cd[this.loadedVertexCount*16 + (i*4+1)] = u8[co+1];
      cd[this.loadedVertexCount*16 + (i*4+2)] = u8[co+2];
      cd[this.loadedVertexCount*16 + (i*4+3)] = u8[co+3];

      // centerAndScaleData
      const csOff = this.loadedVertexCount*4 + i*4;
      this.centerAndScaleData[csOff+0] = c.x;
      this.centerAndScaleData[csOff+1] = c.y;
      this.centerAndScaleData[csOff+2] = c.z;
      this.centerAndScaleData[csOff+3] = mmax/32767;

      // store size*alpha in m.elements[15]
      m.elements[15] = maxS * (u8[co+3]/255);

      // store matrix
      mats.set(m.elements, i*16);
    }

    // Upload both textures in one shot per tile
    const gl = this.renderer.getContext();
    const tex0 = this.renderer.properties.get(this.centerAndScaleTexture).__webglTexture;
    const tex1 = this.renderer.properties.get(this.covAndColorTexture).__webglTexture;

    let count = vertexCount, offset=0;
    while (count>0) {
      const x = this.loadedVertexCount % ATLAS_SIZE;
      const y = Math.floor(this.loadedVertexCount/ATLAS_SIZE);
      const w = Math.min(ATLAS_SIZE-x, count);
      gl.bindTexture(gl.TEXTURE_2D, tex0);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, x, y, w, 1,
        gl.RGBA, gl.FLOAT, this.centerAndScaleData, this.loadedVertexCount*4
      );
      gl.bindTexture(gl.TEXTURE_2D, tex1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,0, x,y, w,1,
        gl.RGBA_INTEGER, gl.UNSIGNED_INT,
        this.covAndColorData, this.loadedVertexCount*4
      );
      this.loadedVertexCount += w;
      count -= w;
    }

    // Send to worker
    this.worker.postMessage(
      { method:'push', matrices:mats.buffer },
      [mats.buffer]
    );
  },

  tick(time, timeDelta) {
    if (!this.sortReady) return;
    this.sortReady = false;
    const vm = this.getModelViewMatrix();
    const pm = this.getProjectionMatrix();
    const m = vm.elements;
    const view = new Float32Array([m[2],m[6],m[10],m[14]]);
    const mvp = new Float32Array(new THREE.Matrix4().multiplyMatrices(pm,vm).elements);
    const scale = Math.max(
      this.object3D.scale.x,
      this.object3D.scale.y,
      this.object3D.scale.z
    );
    this.worker.postMessage(
      { method:'sort', view:view.buffer, mvp:mvp.buffer, scale },
      [view.buffer, mvp.buffer]
    );
  },

  updateQuality() {
    if (this.isCaching) {
      if (this.originalBuffers.length) this.needsQualityUpdate = true;
      return;
    }
    if (!this.originalBuffers.length) return;
    this.loadedVertexCount = 0;
    const geom = this.object3D.children[0].geometry;
    geom.instanceCount = 0;
    this.worker.postMessage({ method:'clear' });
    this.centerAndScaleTexture.needsUpdate = true;
    this.covAndColorTexture.needsUpdate    = true;
    for (const buf of this.originalBuffers) {
      this.pushDataBuffer(buf.slice(0), buf.byteLength/this.rowLength);
    }
    this.sortReady = true;
  },

  getProjectionMatrix(cam) {
    const c = cam||this.camera;
    const m = c.projectionMatrix.clone().elements;
    // flip handedness
    m[4]*=-1; m[5]*=-1; m[6]*=-1; m[7]*=-1;
    return new THREE.Matrix4().fromArray(m);
  },

  getModelViewMatrix(cam) {
    const c = cam||this.camera;
    // world->camera
    const vw = c.matrixWorld.clone().elements;
    vw[1]*=-1; vw[4]*=-1; vw[6]*=-1; vw[9]*=-1; vw[13]*=-1;
    const ow = this.object3D.matrixWorld.clone();
    ow.invert().elements[1]*=-1; ow.elements[4]*=-1;
    ow.elements[6]*=-1; ow.elements[9]*=-1; ow.elements[13]*=-1;
    ow.multiply(new THREE.Matrix4().fromArray(vw)).invert();
    return ow;
  },

  createWorker(self) {
    let matrices;
    function sortSplats(mats, view, mvp, scale=1) {
      const nv = mats.length/16;
      let maxD=-Infinity, minD=Infinity, vc=0;
      const depth = new Float32Array(nv);
      const idxs  = new Uint32Array(nv);
      for (let i=0;i<nv;i++) {
        const px=mats[16*i+12], py=mats[16*i+13], pz=mats[16*i+14];
        const cx = mvp[0]*px + mvp[4]*py + mvp[8]*pz + mvp[12];
        const cy = mvp[1]*px + mvp[5]*py + mvp[9]*pz + mvp[13];
        const cz = mvp[2]*px + mvp[6]*py + mvp[10]*pz + mvp[14];
        const cw = mvp[3]*px + mvp[7]*py + mvp[11]*pz + mvp[15];
        if (cw<=0||cz<=-cw) continue;
        const winv=1/cw;
        const ndcZ = cz*winv;
        if (ndcZ<-1||ndcZ>1) continue;
        const d = view[0]*px + view[1]*py + view[2]*pz + view[3];
        if (d>-0.18) continue;
        if (d<0 && mats[16*i+15]*scale > -0.001*d) {
          depth[vc]=d; idxs[vc]=i; vc++;
          if (d>maxD) maxD=d;
          if (d<minD) minD=d;
        }
      }
      if (vc===0) return new Uint32Array([0]);
      const range = (256*256-1)/(maxD-minD);
      const counts = new Uint32Array(256*256);
      const sizes  = new Uint32Array(vc);
      for (let i=0;i<vc;i++) {
        const s = ((depth[i]-minD)*range)|0;
        sizes[i]=s; counts[s]++;
      }
      const starts = new Uint32Array(256*256);
      for (let i=1;i<256*256;i++) starts[i]=starts[i-1]+counts[i-1];
      const sorted = new Uint32Array(vc);
      for (let i=0;i<vc;i++) {
        sorted[starts[sizes[i]]++]=idxs[i];
      }
      return sorted;
    }

    self.onmessage = e => {
      if (e.data.method==='clear') {
        matrices = undefined;
      } else if (e.data.method==='push') {
        const nm = new Float32Array(e.data.matrices);
        matrices = matrices ? (new Float32Array([...matrices, ...nm])) : nm;
      } else if (e.data.method==='sort') {
        if (!matrices) {
          const out = new Uint32Array([0]);
          self.postMessage({ sortedIndexes: out }, [out.buffer]);
        } else {
          const view = new Float32Array(e.data.view);
          const mvp  = new Float32Array(e.data.mvp);
          const sorted = sortSplats(matrices, view, mvp, e.data.scale);
          self.postMessage({ sortedIndexes: sorted }, [sorted.buffer]);
        }
      }
    };
  },

  processPlyBuffer(buffer) {
    const ub = new Uint8Array(buffer);
    const header = new TextDecoder().decode(ub.slice(0,1024*10));
    const endH = header.indexOf('end_header\n');
    if (endH<0) throw new Error('Invalid PLY header');
    const vc = parseInt(/element vertex (\d+)/.exec(header)[1]);
    let offset=0, rowLen=0;
    const types = {}, offs = {};
    const MAP = { double:'getFloat64', float:'getFloat32', int:'getInt32', uint:'getUint32',
                  short:'getInt16', ushort:'getUint16', uchar:'getUint8' };
    for (const line of header.slice(0,endH).split('\n')) {
      if (!line.startsWith('property ')) continue;
      const [,type,name] = line.split(' ');
      const fn = MAP[type]||'getInt8';
      types[name] = fn;
      offs[name]  = rowLen;
      rowLen += parseInt(fn.match(/\d+/)[0])/8;
    }
    const dv = new DataView(buffer, endH+'end_header\n'.length);
    const attrs = new Proxy({}, {
      get(_,p) {
        if (!types[p]) throw new Error(p+'?');
        return dv[types[p]](row*rowLen + offs[p], true);
      }
    });

    // importance sort
    const sizeList = new Float32Array(vc), idxList = new Uint32Array(vc);
    for (let row=0;row<vc;row++) {
      idxList[row]=row;
      if (types.scale_0) {
        const size = Math.exp(attrs.scale_0)*Math.exp(attrs.scale_1)*Math.exp(attrs.scale_2);
        const op   = 1/(1+Math.exp(-attrs.opacity));
        sizeList[row]=size*op;
      } else sizeList[row]=0;
    }
    idxList.sort((b,a)=>sizeList[a]-sizeList[b]);

    // build output buffer
    const RLEN = vc*rowLen;
    const out  = new ArrayBuffer(RLEN);
    for (let j=0; j<vc; j++) {
      const r = idxList[j];
      const pr = new Float32Array(out, j*rowLen, 3);
      const sc = new Float32Array(out, j*rowLen+12,3);
      const cl = new Uint8ClampedArray(out, j*rowLen+24,4);
      const ro = new Uint8ClampedArray(out, j*rowLen+28,4);
      if (types.scale_0) {
        const ql = Math.hypot(attrs.rot_0,attrs.rot_1,attrs.rot_2,attrs.rot_3);
        ro[0] = attrs.rot_0/ql*128+128;
        ro[1] = attrs.rot_1/ql*128+128;
        ro[2] = attrs.rot_2/ql*128+128;
        ro[3] = attrs.rot_3/ql*128+128;
        sc[0]=Math.exp(attrs.scale_0);
        sc[1]=Math.exp(attrs.scale_1);
        sc[2]=Math.exp(attrs.scale_2);
      } else {
        sc.set([0.01,0.01,0.01]);
        ro.set([255,0,0,0]);
      }
      pr.set([attrs.x,attrs.y,attrs.z]);
      if (types.f_dc_0) {
        const C0 = 0.28209479177387814;
        cl[0]=(0.5+C0*attrs.f_dc_0)*255;
        cl[1]=(0.5+C0*attrs.f_dc_1)*255;
        cl[2]=(0.5+C0*attrs.f_dc_2)*255;
      } else {
        cl[0]=attrs.red; cl[1]=attrs.green; cl[2]=attrs.blue;
      }
      cl[3] = types.opacity
        ? (1/(1+Math.exp(-attrs.opacity)))*255
        : 255;
    }
    return out;
  }
});