AFRAME.registerComponent("gaussian_splatting", {
        schema: {
                src: { type: 'string', default: "" },
                pixelRatio: { type: 'number', default: 0.8 },
                xrPixelRatio: { type: 'number', default: 0.8 },
                // Fixed foveation level. Set to 0 to disable foveated rendering
                foveation: { type: 'number', default: 0.0 }, // no perceived performance gains even with the maximum level
        },
        init: function () {
                // aframe-specific data
                this.xrPixelRatioBounds = { min: 0.75, max: 1.3 };
                this.dynamicResolutionEnabled = this.isMetaQuestBrowser();
                this.frameTimeSamples = [];
                this.lastDynamicUpdate = 0;
                this.targetFrameRate = 72;

                const pixelRatio = this.data.pixelRatio < 0 ? window.devicePixelRatio : this.data.pixelRatio;
                const xrPixelRatio = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
                this.currentXrPixelRatio = this.clampPixelRatio(xrPixelRatio);
                this.el.sceneEl.renderer.setPixelRatio(pixelRatio);
                this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(this.currentXrPixelRatio);

                const gl = this.el.sceneEl.renderer.getContext();
                gl.disable(gl.DITHER);
                this.originalBuffers = [];
                this.needsQualityUpdate = false;
                this.initGL(this.el.sceneEl.camera.el.components.camera.camera, this.el.object3D, this.el.sceneEl.renderer);
                this.loadData(this.data.src);
                this.el.sceneEl.renderer.xr.addEventListener("sessionstart", async () => {
                        const gl = this.el.sceneEl.renderer.getContext();
                        if (gl.makeXRCompatible) {
                                try {
                                        await gl.makeXRCompatible();
                                } catch (e) {
                                        console.warn("makeXRCompatible failed", e);
                                }
                        }
                        const recompileShader = this.setMultiview();
                        if (recompileShader){
                                this.mesh.material.needsUpdate = true;
                        }

                        this.applyFoveationLevel();
                        this.targetFrameRate = this.extractTargetFrameRate();
                        this.currentXrPixelRatio = this.clampPixelRatio(this.data.xrPixelRatio);
                        this.resetFrameTiming();
                        this.updateXRScale();
                });
                this.el.sceneEl.renderer.xr.addEventListener("sessionend", () => {
                        this.applyFoveationLevel();
                        this.targetFrameRate = 72;
                        this.currentXrPixelRatio = this.clampPixelRatio(this.data.xrPixelRatio);
                        this.resetFrameTiming();
                        this.updateXRScale();
                });
                this.el.sceneEl.addEventListener("enter-vr", () => {
                        this.applyFoveationLevel();
                        this.currentXrPixelRatio = this.clampPixelRatio(this.data.xrPixelRatio);
                        this.resetFrameTiming();
                        this.updateXRScale();
                });
                this.el.sceneEl.addEventListener("exit-vr", () => {
                        this.applyFoveationLevel();
                        this.currentXrPixelRatio = this.clampPixelRatio(this.data.xrPixelRatio);
                        this.resetFrameTiming();
                        this.updateXRScale();
                });
        },
        setMultiview: function(){
                const gl = this.el.sceneEl.renderer.getContext();
                const ext = gl.getExtension("OVR_multiview2") ||
                                gl.getExtension("OVR_multiview") ||
                                gl.getExtension("OCULUS_multiview") ||
                                gl.getExtension("WEBGL_multiview");
                if (ext && this.el.sceneEl.renderer.xr.isMultiview) {
                        console.log("Multiview enabled");
                        this.mesh.material.defines.IS_MULTIVIEW = ""; //Sets this flag in the shader to use Multiview code
                        return true;
                } else {
                        console.log("Multiview not supported or disabled");
                        return false;
                }
        },
	// also works from vanilla three.js
	initGL: function (camera, object, renderer) {
		this.camera = camera;
		this.object = object;
                this.renderer = renderer;
                
                this.textureReady = false;
                this.object.frustumCulled = false;

                this.lastCameraMatrix = new THREE.Matrix4();
                this.lastCameraMatrix.identity();
                this.lastObjectMatrix = new THREE.Matrix4();
                this.lastObjectMatrix.identity();
                this.lastScale = new THREE.Vector3(Infinity, Infinity, Infinity);
                this.lastCameraPos = new THREE.Vector3(Infinity, Infinity, Infinity);
                this.lastCameraQuat = new THREE.Quaternion(0, 0, 0, 0);
                this.lastObjectPos = new THREE.Vector3(Infinity, Infinity, Infinity);
                this.lastObjectQuat = new THREE.Quaternion(0, 0, 0, 0);

                this.tmpCameraPos = new THREE.Vector3();
                this.tmpCameraQuat = new THREE.Quaternion();
                this.tmpLocalCameraPos = new THREE.Vector3();
                this.tmpWorldToLocalMatrix = new THREE.Matrix4();
                this.viewRotationMatrix = new THREE.Matrix3();

                this.splatsToDiscard = [];
                this.lodState = null;
                this.lodConfig = {
                        gridSize: 7,
                        levels: [1, 2, 3],
                        nearMultiplier: 0.4,
                        midMultiplier: 1.0,
                };

                const gl = this.renderer.getContext();
                this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
                this.textureSize = Math.min(4096, this.maxTextureSize);
                this.maxSplatCount = this.textureSize * this.textureSize;
                this.initSplatTextures(this.textureSize);

                let splatIndexArray = new Uint32Array(this.maxSplatCount);
                const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
                splatIndexes.setUsage(THREE.DynamicDrawUsage);

               const fadeArray = new Uint8Array(1);
               const fadeAttribute = new THREE.InstancedBufferAttribute(fadeArray, 1, true);
               fadeAttribute.setUsage(THREE.DynamicDrawUsage);

		const baseGeometry = new THREE.BufferGeometry();
		const pos = new Float32Array([
  			-2.0, -2.0, 0.0,  // 0
   			 2.0, -2.0, 0.0,  // 1
   			 2.0,  2.0, 0.0,  // 2
  			-2.0,  2.0, 0.0   // 3
		]);
		baseGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));

		const idx = new Uint16Array([
			0, 1, 2,
  			0, 2, 3
		]);
		baseGeometry.setIndex(new THREE.BufferAttribute(idx, 1));

                const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);
                geometry.setAttribute('splatIndex', splatIndexes);
                geometry.setAttribute('fadeOpacity', fadeAttribute);
                geometry.instanceCount = 1;

                const material = new THREE.ShaderMaterial({
                        glslVersion: THREE.GLSL3,
                        uniforms: {
                                viewport: { value: new Float32Array([1980, 1080]) }, // Dummy. will be overwritten
                                viewportInv: { value: new Float32Array([1.0, 1.0]) },
                                focal: { value: 1000.0 }, // Dummy. will be overwritten
                                centerAndScaleTexture: { value: this.centerAndScaleTexture },
                                covAndColorTexture: { value: this.covAndColorTexture },
                                textureWidth: { value: this.textureSize },
                                gsProjectionMatrix: { value: this.getProjectionMatrix() } ,
                                gsModelViewMatrix: { value: this.getModelViewMatrix() },
                                gsProjectionMatrixRight: { value: this.getProjectionMatrix() },
                                gsModelViewMatrixRight: { value: this.getModelViewMatrix() },
                                viewRotationMatrix: { value: new THREE.Matrix3() },
                        },
			vertexShader: `
                                precision highp usampler2D;

				out vec4 vColor;
				out vec2 vPosition;
				uniform vec2 viewportInv;
				uniform float focal;
				uniform mat4 gsProjectionMatrix;
				uniform mat4 gsModelViewMatrix;
				uniform mat3 viewRotationMatrix;
				 #ifdef IS_MULTIVIEW
				uniform mat4 gsProjectionMatrixRight;
				uniform mat4 gsModelViewMatrixRight;
                                #endif

                                in uint splatIndex;
                                in float fadeOpacity;
                                uniform sampler2D centerAndScaleTexture;
                                uniform usampler2D covAndColorTexture;
                                uniform int textureWidth;

				vec2 unpackInt16(uint value) {
					int v0 = int(value) >> 16;
					int v1 = int(value << 16) >> 16;
					return vec2(float(v1), float(v0));
				}

				void main() {
                                        uint texWidth = uint(textureWidth);
					ivec2 texPos = ivec2(int(splatIndex % texWidth), int(splatIndex / texWidth));
					vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);
	
					vec4 camspace;
                                        vec4 pos2d;

                                        #ifdef IS_MULTIVIEW
                                        if (gl_ViewID_OVR == 0u) {
                                                camspace = gsModelViewMatrix * vec4(centerAndScaleData.xyz, 1);
                                                pos2d = gsProjectionMatrix * camspace;
                                        } else {
                                                camspace = gsModelViewMatrixRight * vec4(centerAndScaleData.xyz, 1);
                                                pos2d = gsProjectionMatrixRight * camspace;
                                        }
                                        #else
                                        camspace = gsModelViewMatrix * vec4(centerAndScaleData.xyz, 1);
                                        pos2d = gsProjectionMatrix * camspace;
                                        #endif

                                        float bounds = pos2d.w;

                                        if (pos2d.z < -bounds || pos2d.x < -bounds || pos2d.x > bounds || pos2d.y < -bounds || pos2d.y > bounds) {
						gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                                                return;
                                        }
                                        
					uvec4 covAndColorData = texelFetch(covAndColorTexture, texPos, 0);
					float scale = centerAndScaleData.w;

					vec2 cov3D_M11_M12 = unpackInt16(covAndColorData.x) * scale;
					vec2 cov3D_M13_M22 = unpackInt16(covAndColorData.y) * scale;
					vec2 cov3D_M23_M33 = unpackInt16(covAndColorData.z) * scale;

					mat3 Vrk = mat3(
						cov3D_M11_M12.x, cov3D_M11_M12.y, cov3D_M13_M22.x,
						cov3D_M11_M12.y, cov3D_M13_M22.y, cov3D_M23_M33.x,
						cov3D_M13_M22.x, cov3D_M23_M33.x, cov3D_M23_M33.y
					);

					float invZ = 1.0 / camspace.z;
					float invZ2 = invZ * invZ;

					mat3 J = mat3(
						focal * invZ, 0.0, -focal * camspace.x * invZ2,
						0.0, -focal * invZ, focal * camspace.y * invZ2,
						0.0, 0.0, 0.0
					);

					mat3 cov = transpose(viewRotationMatrix * J) * Vrk * (viewRotationMatrix * J);

					vec2 vCenter = pos2d.xy / pos2d.w;

					float diag1 = cov[0][0] + 0.3;
					float offDiag = cov[0][1];
					float diag2 = cov[1][1] + 0.3;

					float mid = 0.5 * (diag1 + diag2);
					float radius = length(vec2((diag1 - diag2) * 0.5, offDiag));

					float lambda1 = mid + radius;
					float lambda2 = max(mid - radius, 0.1);

					vec2 diagVec = normalize(vec2(offDiag, lambda1 - diag1));
					vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagVec;
					vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagVec.y, -diagVec.x);

                                        uint colorUint = covAndColorData.w;

                                        float fade = fadeOpacity;

                                        vColor = vec4(
                                                vec3(colorUint & 0xFFu, (colorUint >> 8) & 0xFFu, (colorUint >> 16) & 0xFFu),
                                                colorUint >> 24
                                        ) * 0.003921569;
                                        vColor.a *= fade;

					vPosition = position.xy;

					gl_Position = vec4(vCenter + (position.x * v2 + position.y * v1) * viewportInv, pos2d.z / pos2d.w, 1.0);
				}
				`,
			fragmentShader: `
				in vec4 vColor;
				in vec2 vPosition;
                                out vec4 out_FragColor;

                                void main () {
                                        float len2 = dot(vPosition, vPosition);
                                        if (len2 > 4.0) discard;
                                        float B = exp(-len2) * vColor.a;
                                        out_FragColor = vec4(vColor.rgb, B);
                                }
			`,
			blending: THREE.CustomBlending,
			blendSrcAlpha: THREE.OneFactor,
			depthTest: true,
        		depthWrite: false,
                        transparent: true
                });
                material.dithering = false;

		material.onBeforeRender = ((renderer, scene, camera, geometry, object, group) => {
                        let projectionMatrix;
                        let viewMatrix;

                        if (this.el.sceneEl.renderer.xr.isMultiview) {
                                projectionMatrix = this.getProjectionMatrix(camera.cameras[0]);
                                let rightProjectionMatrix = this.getProjectionMatrix(camera.cameras[1]);
                                mesh.material.uniforms.gsProjectionMatrix.value = projectionMatrix;
                                mesh.material.uniforms.gsProjectionMatrixRight.value = rightProjectionMatrix;

                                viewMatrix = this.getModelViewMatrix(camera.cameras[0]);
                                let rightViewMatrix = this.getModelViewMatrix(camera.cameras[1]);
                                mesh.material.uniforms.gsModelViewMatrix.value = viewMatrix;
                                mesh.material.uniforms.gsModelViewMatrixRight.value = rightViewMatrix;
                        } else {
                                projectionMatrix = this.getProjectionMatrix(camera);
                                mesh.material.uniforms.gsProjectionMatrix.value = projectionMatrix;

                                viewMatrix = this.getModelViewMatrix(camera);
                                mesh.material.uniforms.gsModelViewMatrix.value = viewMatrix;
                        }

                        this.viewRotationMatrix.setFromMatrix4(viewMatrix).transpose();
                        mesh.material.uniforms.viewRotationMatrix.value.copy(this.viewRotationMatrix);

                        let viewport = new THREE.Vector4();
                        renderer.getCurrentViewport(viewport);

                        const focal = (viewport.w / 2.0) * Math.abs(projectionMatrix.elements[5]);

                        material.uniforms.viewport.value[0] = viewport.z;
                        material.uniforms.viewport.value[1] = viewport.w;
                        material.uniforms.viewportInv.value[0] = 2.0 / viewport.z;
                        material.uniforms.viewportInv.value[1] = 2.0 / viewport.w;
                        material.uniforms.focal.value = focal;
		});
		
                mesh = new THREE.Mesh(geometry, material);
                mesh.frustumCulled = false;
                this.object.add(mesh);
                this.mesh = mesh;

                if (this.el.sceneEl.renderer.xr.isPresenting) {
                        console.log("Page refreshed with VR running - multiview flag is being reset");
                        this.setMultiview();      //Set multiview on mesh if VR is already running
                }

                this.worker = new Worker(
                        URL.createObjectURL(
                                new Blob(["(", this.createWorker.toString(), ")(self)"], {
                                        type: "application/javascript",
                                }),
                        ),
                );
                this.lastWorkerUpdateTime = performance.now();
                window.lastWorkerUpdateTime = this.lastWorkerUpdateTime;

                this.worker.onmessage = (e) => {
                        this.lastWorkerUpdateTime = performance.now();
                        window.lastWorkerUpdateTime = this.lastWorkerUpdateTime;
                        if (e.data.method === "sort") {
                                const indexes = new Uint32Array(e.data.sortedIndexes);
                                let indexAttr = mesh.geometry.getAttribute('splatIndex');
                                if (!indexAttr || indexAttr.array.length !== indexes.length) {
                                        indexAttr = new THREE.InstancedBufferAttribute(indexes, 1, false);
                                        indexAttr.setUsage(THREE.DynamicDrawUsage);
                                        mesh.geometry.setAttribute('splatIndex', indexAttr);
                                } else {
                                        indexAttr.array = indexes;
                                        indexAttr.count = indexes.length;
                                        indexAttr.needsUpdate = true;
                                }
                                mesh.geometry.instanceCount = indexes.length;
                                if (e.data.fadeOpacities) {
                                        const fades = new Uint8Array(e.data.fadeOpacities);
                                        let fadeAttr = mesh.geometry.getAttribute('fadeOpacity');
                                        if (!fadeAttr || fadeAttr.array.length !== fades.length) {
                                                fadeAttr = new THREE.InstancedBufferAttribute(fades, 1, true);
                                                fadeAttr.setUsage(THREE.DynamicDrawUsage);
                                                mesh.geometry.setAttribute('fadeOpacity', fadeAttr);
                                        } else {
                                                fadeAttr.array = fades;
                                                fadeAttr.count = fades.length;
                                                fadeAttr.needsUpdate = true;
                                        }
                                }
                                this.sortReady = true;
                        } else if (e.data.method === "filter") {
                                this.filterReady = true;
                        }
                };
                this.sortReady = true;
                this.filterReady = true;

                this.occlusionWorker = new Worker(
                        URL.createObjectURL(
                                new Blob(["(", this.createOcclusionWorker.toString(), ")(self)"], {
                                        type: "application/javascript",
                                }),
                        ),
                );

                this.occlusionWorker.onmessage = (e) => {
                        if (e.data.method === "occlude") {
                                const discarded = new Uint32Array(e.data.discard);
                                this.splatsToDiscard = Array.from(discarded);
                                this.occlusionReady = true;
                        }
                };
                this.occlusionReady = true;
        },
        initSplatTextures: function (textureSize) {
                this.textureSize = textureSize;
                this.maxSplatCount = textureSize * textureSize;
                const previousCenterData = this.centerAndScaleData;
                const previousCovData = this.covAndColorData;
                this.centerAndScaleData = new Float32Array(this.maxSplatCount * 4);
                this.covAndColorData = new Uint32Array(this.maxSplatCount * 4);
                if (previousCenterData) {
                        this.centerAndScaleData.set(previousCenterData.subarray(0, Math.min(previousCenterData.length, this.centerAndScaleData.length)));
                }
                if (previousCovData) {
                        this.covAndColorData.set(previousCovData.subarray(0, Math.min(previousCovData.length, this.covAndColorData.length)));
                }

                this.centerAndScaleTexture = new THREE.DataTexture(this.centerAndScaleData, textureSize, textureSize, THREE.RGBA, THREE.FloatType);
                this.centerAndScaleTexture.generateMipmaps = false;
                this.centerAndScaleTexture.minFilter = THREE.NearestFilter;
                this.centerAndScaleTexture.magFilter = THREE.NearestFilter;
                this.centerAndScaleTexture.needsUpdate = true;

                this.covAndColorTexture = new THREE.DataTexture(this.covAndColorData, textureSize, textureSize, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
                this.covAndColorTexture.generateMipmaps = false;
                this.covAndColorTexture.minFilter = THREE.NearestFilter;
                this.covAndColorTexture.magFilter = THREE.NearestFilter;
                this.covAndColorTexture.internalFormat = "RGBA32UI";
                this.covAndColorTexture.needsUpdate = true;

                if (this.mesh && this.mesh.material && this.mesh.material.uniforms) {
                        this.mesh.material.uniforms.centerAndScaleTexture.value = this.centerAndScaleTexture;
                        this.mesh.material.uniforms.covAndColorTexture.value = this.covAndColorTexture;
                        this.mesh.material.uniforms.textureWidth.value = this.textureSize;
                }
                if (this.mesh && this.mesh.geometry) {
                        const splatIndexAttr = this.mesh.geometry.getAttribute('splatIndex');
                        if (splatIndexAttr && splatIndexAttr.array.length < this.maxSplatCount) {
                                const splatIndexArray = new Uint32Array(this.maxSplatCount);
                                const newAttr = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
                                newAttr.setUsage(THREE.DynamicDrawUsage);
                                this.mesh.geometry.setAttribute('splatIndex', newAttr);
                        }
                }
                this.textureReady = false;
        },
        ensureSplatCapacity: function (requiredCount) {
                if (!requiredCount || requiredCount <= this.maxSplatCount) {
                        return;
                }
                const minSize = Math.ceil(Math.sqrt(requiredCount));
                const nextSize = Math.min(this.maxTextureSize, Math.max(this.textureSize, minSize));
                if (nextSize === this.textureSize) {
                        console.warn("Requested splat count exceeds GPU texture limit.", requiredCount, this.maxSplatCount);
                        return;
                }
                this.initSplatTextures(nextSize);
        },
        loadData: function (src) {
                this.loadedVertexCount = 0;
                this.rowLength = 3 * 4 + 3 * 4 + 4 + 4;
                this.worker.postMessage({ method: "clear" });
                this.occlusionWorker.postMessage({ method: "clear" });
                this.originalBuffers = [];
                this.originalBufferCounts = [];
                this.isCaching = true;
                this.lodState = null;
		const createPendingBuffer = () => ({
			chunks: [],
			length: 0,
			append(chunk) {
				if (chunk && chunk.length) {
					this.chunks.push(chunk);
					this.length += chunk.length;
				}
			},
			getByteLength() {
				return this.length;
			},
			peekBytes(count) {
				if (this.length === 0) {
					return new Uint8Array(0);
				}
				const needed = Math.min(count, this.length);
				const head = this.chunks[0];
				if (head.length >= needed) {
					return head.subarray(0, needed);
				}
				const out = new Uint8Array(needed);
				let offset = 0;
				for (const chunk of this.chunks) {
					const toCopy = Math.min(chunk.length, needed - offset);
					out.set(chunk.subarray(0, toCopy), offset);
					offset += toCopy;
					if (offset >= needed) {
						break;
					}
				}
				return out;
			},
			consumeBytes(count) {
				const actual = Math.min(count, this.length);
				if (actual <= 0) {
					return new Uint8Array(0);
				}
				const head = this.chunks[0];
				if (head.length >= actual) {
					const out = head.subarray(0, actual);
					if (head.length === actual) {
						this.chunks.shift();
					} else {
						this.chunks[0] = head.subarray(actual);
					}
					this.length -= actual;
					return out;
				}
				const out = new Uint8Array(actual);
				let offset = 0;
				while (offset < actual) {
					const chunk = this.chunks[0];
					const toCopy = Math.min(chunk.length, actual - offset);
					out.set(chunk.subarray(0, toCopy), offset);
					offset += toCopy;
					if (toCopy === chunk.length) {
						this.chunks.shift();
					} else {
						this.chunks[0] = chunk.subarray(toCopy);
					}
				}
				this.length -= actual;
				return out;
			},
			discard(count) {
				this.consumeBytes(count);
			},
			toUint8Array() {
				if (this.length === 0) {
					return new Uint8Array(0);
				}
				const out = new Uint8Array(this.length);
				let offset = 0;
				for (const chunk of this.chunks) {
					out.set(chunk, offset);
					offset += chunk.length;
				}
				return out;
			},
		});
		const pending = createPendingBuffer();
                const rowLength = this.rowLength;
                const ensureSplatCapacity = this.ensureSplatCapacity.bind(this);
                const parsePlyHeader = this.parsePlyHeader.bind(this);
                const buildPlyBinaryBatch = this.buildPlyBinaryBatch.bind(this);
                const processPlyBuffer = this.processPlyBuffer.bind(this);
                const pushDataBuffer = this.pushDataBuffer.bind(this);
                const rendererProperties = this.renderer.properties;
                const centerTexture = this.centerAndScaleTexture;
                const covTexture = this.covAndColorTexture;

		fetch(src)
			.then(async (data) => {
				const reader = data.body.getReader();

				let bytesDownloaded = 0;
				let bytesProcesses = 0;
				let _totalDownloadBytes = data.headers.get("Content-Length");
				let totalDownloadBytes = _totalDownloadBytes ? parseInt(_totalDownloadBytes) : undefined;

				const start = Date.now();
				let lastReportedProgress = 0;
				let isPly = null;
				let plyState = null;
				let capacityEstimated = false;
				const plyPending = pending;
				const maxPlyBatchBytes = 64 * 1024 * 1024;
				const decoder = new TextDecoder();

				while (true) {
					try {
						const { value, done } = await reader.read();
						if (done) {
							console.log("Process Completed.");
							break;
						}
						bytesDownloaded += value.length;
						if (totalDownloadBytes != undefined) {
							const mbps = (bytesDownloaded / 1024 / 1024) / ((Date.now() - start) / 1000);
							const percent = bytesDownloaded / totalDownloadBytes * 100;
							if (percent - lastReportedProgress > 1) {
                                                        console.log("Progress:", percent.toFixed(2) + "%", mbps.toFixed(2) + " Mbps");
								lastReportedProgress = percent;
							}
						} else {
                                                console.log("Progress:", bytesDownloaded, ", unknown total");
						}
						if (isPly === null) {
							const probe = decoder.decode(value.subarray(0, 4));
							isPly = probe.startsWith("ply");
                                                        if (!isPly && totalDownloadBytes && !capacityEstimated) {
                                                                const estimatedCount = Math.floor(totalDownloadBytes / rowLength);
                                                                ensureSplatCapacity(estimatedCount);
                                                                capacityEstimated = true;
                                                        }
						}
						pending.append(value);
						if (!this.textureReady &&
							rendererProperties.get(centerTexture) &&
							rendererProperties.get(covTexture)) {
							this.textureReady = true;
						}

						if (isPly && !plyState) {
							plyState = parsePlyHeader(plyPending.peekBytes(1024 * 10));
                                                        if (plyState && plyState.vertexCount && !capacityEstimated) {
                                                                ensureSplatCapacity(plyState.vertexCount);
                                                                capacityEstimated = true;
                                                        }
							if (plyState && plyState.format === "binary_little_endian") {
								plyPending.discard(plyState.headerByteLength);
								bytesProcesses += plyState.headerByteLength;
							}
						}

						if (isPly && plyState && plyState.format === "binary_little_endian" && this.textureReady) {
							let rowsAvailable = Math.floor(plyPending.getByteLength() / plyState.rowOffset);
							const maxRowsPerBatch = Math.max(1, Math.floor(maxPlyBatchBytes / plyState.rowOffset));
							while (rowsAvailable > 0) {
								const rowsToProcess = Math.min(rowsAvailable, maxRowsPerBatch);
								const batchBytes = rowsToProcess * plyState.rowOffset;
								const batchData = plyPending.consumeBytes(batchBytes);
								const result = buildPlyBinaryBatch(plyState, batchData, rowsToProcess);
								if (result.vertexCount > 0) {
									pushDataBuffer(result.buffer, result.vertexCount);
								}
								bytesProcesses += batchBytes;
								rowsAvailable = Math.floor(plyPending.getByteLength() / plyState.rowOffset);
							}
						}

						if (!isPly && this.textureReady) {
							const availableBytes = pending.getByteLength();
							const vertexCount = Math.floor(availableBytes / rowLength);
							if (vertexCount > 0) {
								const batchBytes = vertexCount * rowLength;
								const batchData = pending.consumeBytes(batchBytes);
								pushDataBuffer(batchData.buffer, vertexCount);
								bytesProcesses += batchBytes;
							}
						}
					} catch (error) {
						console.error(error);
						break;
					}
				}

				if (bytesDownloaded - bytesProcesses > 0) {
					if (isPly && plyState && plyState.format === "binary_little_endian") {
						if (this.textureReady) {
							let rowsAvailable = Math.floor(plyPending.getByteLength() / plyState.rowOffset);
							const maxRowsPerBatch = Math.max(1, Math.floor(maxPlyBatchBytes / plyState.rowOffset));
							while (rowsAvailable > 0) {
								const rowsToProcess = Math.min(rowsAvailable, maxRowsPerBatch);
								const batchBytes = rowsToProcess * plyState.rowOffset;
								const batchData = plyPending.consumeBytes(batchBytes);
								const result = buildPlyBinaryBatch(plyState, batchData, rowsToProcess);
								if (result.vertexCount > 0) {
									pushDataBuffer(result.buffer, result.vertexCount);
								}
								bytesProcesses += batchBytes;
								rowsAvailable = Math.floor(plyPending.getByteLength() / plyState.rowOffset);
							}
						}
					} else if (isPly) {
						const plyBuffer = plyPending.toUint8Array().buffer;
						let concatenatedChunks = new Uint8Array(processPlyBuffer(plyBuffer));
						pushDataBuffer(concatenatedChunks.buffer, Math.floor(concatenatedChunks.byteLength / rowLength));
					} else {
						const remainingBytes = pending.getByteLength();
						const vertexCount = Math.floor(remainingBytes / rowLength);
						if (vertexCount > 0) {
							const batchBytes = vertexCount * rowLength;
							const batchData = pending.consumeBytes(batchBytes);
							pushDataBuffer(batchData.buffer, vertexCount);
						}
					}
				}
                        })
                        .finally(() => {
                                this.isCaching = false;
                                if (this.needsQualityUpdate) {
                                        this.needsQualityUpdate = false;
                                        this.updateQuality();
                                }
                                this.buildLodTiles();
                                this.occludeSplatsNow();
                                this.filterSplatsNow();
                                this.sortSplatsNow();
                        });
        },
        pushDataBuffer: function (buffer, vertexCount) {
                if (this.loadedVertexCount + vertexCount > this.maxSplatCount) {
                        vertexCount = this.maxSplatCount - this.loadedVertexCount;
                }
                if (vertexCount <= 0) {
                        return;
                }
                if (this.isCaching) {
                        const expectedBytes = vertexCount * this.rowLength;
                        const cachedBuffer = buffer.byteLength === expectedBytes
                                ? buffer
                                : buffer.slice(0, expectedBytes);
                        this.originalBuffers.push(cachedBuffer);
                        this.originalBufferCounts.push(vertexCount);
                }
                
		let u_buffer = new Uint8Array(buffer);
		let f_buffer = new Float32Array(buffer);
                let matrices = new Float32Array(vertexCount * 16);
                let normals = new Float32Array(vertexCount * 3);

                const axisX = new THREE.Vector3();
                const axisY = new THREE.Vector3();
                const axisZ = new THREE.Vector3();

		const covAndColorData_uint8 = new Uint8Array(this.covAndColorData.buffer);
		const covAndColorData_int16 = new Int16Array(this.covAndColorData.buffer);
                for (let i = 0; i < vertexCount; i++) {
			let quat = new THREE.Quaternion(
				(u_buffer[32 * i + 28 + 1] - 128) / 128.0,
				(u_buffer[32 * i + 28 + 2] - 128) / 128.0,
				-(u_buffer[32 * i + 28 + 3] - 128) / 128.0,
				(u_buffer[32 * i + 28 + 0] - 128) / 128.0,
			);
			let center = new THREE.Vector3(
				f_buffer[8 * i + 0],
				f_buffer[8 * i + 1],
				-f_buffer[8 * i + 2]
			);
                        let scale = new THREE.Vector3(
                                f_buffer[8 * i + 3 + 0],
                                f_buffer[8 * i + 3 + 1],
                                f_buffer[8 * i + 3 + 2]
                        );
                        const maxScale = 100.0;
                        const minScale = 0.0001;
                        if (Math.max(scale.x, scale.y, scale.z) > maxScale ||
                                Math.max(scale.x, scale.y, scale.z) < minScale) {
                                continue;
                        }
                        let mtx = new THREE.Matrix4();
                        mtx.makeRotationFromQuaternion(quat);
                        mtx.transpose();
                        mtx.scale(scale);
                        let mtx_t = mtx.clone()
                        mtx.transpose();
                        mtx.premultiply(mtx_t);
                        mtx.setPosition(center);

                        axisX.set(1, 0, 0).applyQuaternion(quat);
                        axisY.set(0, 1, 0).applyQuaternion(quat);
                        axisZ.set(0, 0, 1).applyQuaternion(quat);

                        let smallestAxisIndex = 0;
                        let smallestValue = scale.x;
                        if (scale.y < smallestValue) {
                                smallestAxisIndex = 1;
                                smallestValue = scale.y;
                        }
                        if (scale.z < smallestValue) {
                                smallestAxisIndex = 2;
                                smallestValue = scale.z;
                        }
                        let chosenAxis = smallestAxisIndex === 0 ? axisX : smallestAxisIndex === 1 ? axisY : axisZ;
                        normals[i * 3 + 0] = chosenAxis.x;
                        normals[i * 3 + 1] = chosenAxis.y;
                        normals[i * 3 + 2] = chosenAxis.z;

			let cov_indexes = [0, 1, 2, 5, 6, 10];
			let max_value = 0.0;
			for (let j = 0; j < cov_indexes.length; j++) {
				if (Math.abs(mtx.elements[cov_indexes[j]]) > max_value) {
					max_value = Math.abs(mtx.elements[cov_indexes[j]]);
				}
			}

			let destOffset = this.loadedVertexCount * 4 + i * 4;
			this.centerAndScaleData[destOffset + 0] = center.x;
			this.centerAndScaleData[destOffset + 1] = center.y;
			this.centerAndScaleData[destOffset + 2] = center.z;
			this.centerAndScaleData[destOffset + 3] = max_value / 32767.0;

			destOffset = this.loadedVertexCount * 8 + i * 4 * 2;
			for (let j = 0; j < cov_indexes.length; j++) {
				covAndColorData_int16[destOffset + j] = parseInt(mtx.elements[cov_indexes[j]] * 32767.0 / max_value);
			}

			// RGBA
			destOffset = this.loadedVertexCount * 16 + (i * 4 + 3) * 4;
			covAndColorData_uint8[destOffset + 0] = u_buffer[32 * i + 24 + 0];
			covAndColorData_uint8[destOffset + 1] = u_buffer[32 * i + 24 + 1];
			covAndColorData_uint8[destOffset + 2] = u_buffer[32 * i + 24 + 2];
                        covAndColorData_uint8[destOffset + 3] = u_buffer[32 * i + 24 + 3];

                        // Store scale information and transparency for later processing
                        mtx.elements[15] = Math.max(scale.x, scale.y, scale.z);
                        mtx.elements[3] = Math.min(scale.x, scale.y, scale.z);
                        mtx.elements[11] = u_buffer[32*i + 24 + 3] / 255.0;

			for (let j = 0; j < 16; j++) {
				matrices[i * 16 + j] = mtx.elements[j];
			}
		}

		const gl = this.renderer.getContext();
		while (vertexCount > 0) {
			let width = 0;
			let height = 0;
			let xoffset = (this.loadedVertexCount % this.textureSize);
			let yoffset = Math.floor(this.loadedVertexCount / this.textureSize);
			if (this.loadedVertexCount % this.textureSize != 0) {
				width = Math.min(this.textureSize, xoffset + vertexCount) - xoffset;
				height = 1;
			} else if (Math.floor(vertexCount / this.textureSize) > 0) {
				width = this.textureSize;
				height = Math.floor(vertexCount / this.textureSize);
			} else {
				width = vertexCount % this.textureSize;
				height = 1;
			}

			const centerAndScaleTextureProperties = this.renderer.properties.get(this.centerAndScaleTexture);
			gl.bindTexture(gl.TEXTURE_2D, centerAndScaleTextureProperties.__webglTexture);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, xoffset, yoffset, width, height, gl.RGBA, gl.FLOAT, this.centerAndScaleData, this.loadedVertexCount * 4);

                        const covAndColorTextureProperties = this.renderer.properties.get(this.covAndColorTexture);
                        gl.bindTexture(gl.TEXTURE_2D, covAndColorTextureProperties.__webglTexture);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, xoffset, yoffset, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.covAndColorData, this.loadedVertexCount * 4);

			this.loadedVertexCount += width * height;
			vertexCount -= width * height;
		}

                const matricesCopy = matrices.slice();
                this.worker.postMessage({
                        method: "push",
                        matrices: matrices.buffer
                }, [matrices.buffer]);
                this.occlusionWorker.postMessage({
                        method: "push",
                        matrices: matricesCopy.buffer,
                        normals: normals.buffer
                }, [matricesCopy.buffer, normals.buffer]);
	},
        buildLodTiles: function () {
                if (this.lodState && this.lodState.generated) {
                        return;
                }
                const totalSplats = this.loadedVertexCount;
                if (!totalSplats || !this.centerAndScaleData || totalSplats <= 0) {
                        return;
                }
                const gridSize = this.lodConfig.gridSize;
                const min = new THREE.Vector3(Infinity, Infinity, Infinity);
                const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
                for (let i = 0; i < totalSplats; i++) {
                        const offset = i * 4;
                        const x = this.centerAndScaleData[offset + 0];
                        const y = this.centerAndScaleData[offset + 1];
                        const z = this.centerAndScaleData[offset + 2];
                        if (x < min.x) min.x = x;
                        if (y < min.y) min.y = y;
                        if (z < min.z) min.z = z;
                        if (x > max.x) max.x = x;
                        if (y > max.y) max.y = y;
                        if (z > max.z) max.z = z;
                }
                const size = new THREE.Vector3(
                        Math.max(1e-5, max.x - min.x),
                        Math.max(1e-5, max.y - min.y),
                        Math.max(1e-5, max.z - min.z)
                );
                const tileSize = new THREE.Vector3(
                        size.x / gridSize,
                        size.y / gridSize,
                        size.z / gridSize
                );
                const tiles = [];
                const tileCount = gridSize * gridSize * gridSize;
                for (let i = 0; i < tileCount; i++) {
                        tiles.push({
                                indices: [],
                                lods: [],
                                activeLod: -1,
                                center: new THREE.Vector3(),
                                min: new THREE.Vector3(),
                                max: new THREE.Vector3(),
                        });
                }
                const clampIndex = (v) => Math.max(0, Math.min(gridSize - 1, v));
                for (let i = 0; i < totalSplats; i++) {
                        const offset = i * 4;
                        const x = this.centerAndScaleData[offset + 0];
                        const y = this.centerAndScaleData[offset + 1];
                        const z = this.centerAndScaleData[offset + 2];
                        const ix = clampIndex(Math.floor((x - min.x) / tileSize.x));
                        const iy = clampIndex(Math.floor((y - min.y) / tileSize.y));
                        const iz = clampIndex(Math.floor((z - min.z) / tileSize.z));
                        const tileIndex = ix + iy * gridSize + iz * gridSize * gridSize;
                        tiles[tileIndex].indices.push(i);
                }
                const selectStride = (list, stride, offset) => {
                        if (stride <= 1 || list.length <= 1) {
                                return list.slice();
                        }
                        const selected = [];
                        for (let i = 0; i < list.length; i++) {
                                if (i % stride === offset) {
                                        selected.push(list[i]);
                                }
                        }
                        if (selected.length === 0 && list.length > 0) {
                                selected.push(list[0]);
                        }
                        return selected;
                };
                const levels = this.lodConfig.levels;
                for (let z = 0; z < gridSize; z++) {
                        for (let y = 0; y < gridSize; y++) {
                                for (let x = 0; x < gridSize; x++) {
                                        const index = x + y * gridSize + z * gridSize * gridSize;
                                        const tile = tiles[index];
                                        const center = tile.center;
                                        const tileMin = tile.min;
                                        const tileMax = tile.max;
                                        center.set(
                                                min.x + (x + 0.5) * tileSize.x,
                                                min.y + (y + 0.5) * tileSize.y,
                                                min.z + (z + 0.5) * tileSize.z
                                        );
                                        tileMin.set(
                                                min.x + x * tileSize.x,
                                                min.y + y * tileSize.y,
                                                min.z + z * tileSize.z
                                        );
                                        tileMax.set(
                                                min.x + (x + 1) * tileSize.x,
                                                min.y + (y + 1) * tileSize.y,
                                                min.z + (z + 1) * tileSize.z
                                        );
                                        const baseList = tile.indices;
                                        tile.lods = levels.map((stride) => {
                                                const offset = (index + stride) % stride;
                                                return selectStride(baseList, stride, offset);
                                        });
                                }
                        }
                }
                this.lodState = {
                        generated: true,
                        gridSize,
                        tileSize,
                        min,
                        max,
                        tiles,
                        activeIndices: new Uint32Array(totalSplats),
                        activeCount: totalSplats,
                        activeVersion: 0,
                };
                this.camera.getWorldPosition(this.tmpCameraPos);
                this.updateTileLods(true);
        },
        updateTileLods: function (force = false) {
                if (!this.lodState || !this.lodState.generated) {
                        return;
                }
                const tiles = this.lodState.tiles;
                if (!tiles || tiles.length === 0) return;
                this.camera.getWorldPosition(this.tmpCameraPos);
                const cameraPos = this.tmpCameraPos;
                const objectMatrix = this.object.matrixWorld;
                this.tmpWorldToLocalMatrix.copy(objectMatrix).invert();
                this.tmpLocalCameraPos.copy(cameraPos).applyMatrix4(this.tmpWorldToLocalMatrix);
                const localCameraPos = this.tmpLocalCameraPos;
                const tileSize = this.lodState.tileSize;
                const nearDistance = this.lodConfig.nearMultiplier;
                const midDistance = this.lodConfig.midMultiplier;
                let changed = false;
                let activeCount = 0;
                for (let i = 0; i < tiles.length; i++) {
                        const tile = tiles[i];
                        const tileMin = tile.min;
                        const tileMax = tile.max;
                        const dx = Math.max(tileMin.x - localCameraPos.x, 0, localCameraPos.x - tileMax.x);
                        const dy = Math.max(tileMin.y - localCameraPos.y, 0, localCameraPos.y - tileMax.y);
                        const dz = Math.max(tileMin.z - localCameraPos.z, 0, localCameraPos.z - tileMax.z);
                        const dist = Math.hypot(
                                dx / tileSize.x,
                                dy / tileSize.y,
                                dz / tileSize.z
                        );
                        let lodLevel = 0;
                        if (dist > midDistance) {
                                lodLevel = 2;
                        } else if (dist > nearDistance) {
                                lodLevel = 1;
                        }
                        lodLevel = Math.min(lodLevel, tile.lods.length - 1);
                        if (force || lodLevel !== tile.activeLod) {
                                tile.activeLod = lodLevel;
                                changed = true;
                        }
                        const list = tile.lods[lodLevel] || [];
                        activeCount += list.length;
                }
                if (!changed && !force) {
                        return;
                }
                const maxActiveCount = this.loadedVertexCount || (this.lodState.activeIndices ? this.lodState.activeIndices.length : 0);
                if (maxActiveCount > 0 && activeCount > maxActiveCount) {
                        activeCount = maxActiveCount;
                }
                let activeIndices = this.lodState.activeIndices;
                if (!activeIndices || activeIndices.length < activeCount) {
                        activeIndices = new Uint32Array(activeCount);
                } else if (activeIndices.length !== activeCount) {
                        activeIndices = activeIndices.subarray(0, activeCount);
                }
                let offset = 0;
                for (let i = 0; i < tiles.length; i++) {
                        const list = tiles[i].lods[tiles[i].activeLod] || [];
                        const remaining = activeCount - offset;
                        if (remaining <= 0) {
                                break;
                        }
                        if (list.length > remaining) {
                                activeIndices.set(list.slice(0, remaining), offset);
                                offset += remaining;
                                break;
                        }
                        activeIndices.set(list, offset);
                        offset += list.length;
                }
                this.lodState.activeIndices = activeIndices;
                this.lodState.activeCount = activeCount;
                this.lodState.activeVersion += 1;
                const workerActive = activeIndices.subarray(0, activeCount);
                this.worker.postMessage({
                        method: "setActive",
                        active: workerActive,
                        activeCount: activeCount
                });
                if (this.occlusionWorker) {
                        const occlusionActive = activeIndices.subarray(0, activeCount);
                        this.occlusionWorker.postMessage({
                                method: "setActive",
                                active: occlusionActive,
                                activeCount: activeCount
                        });
                }
        },
        tick: function (time, timeDelta) {
                this.updateDynamicResolution(time, timeDelta);

                this.camera.getWorldPosition(this.tmpCameraPos);
                
                const camPosChanged = this.tmpCameraPos.distanceToSquared(this.lastCameraPos) > 0.001;

                this.camera.getWorldQuaternion(this.tmpCameraQuat);
                
                const camRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.tmpCameraQuat.dot(this.lastCameraQuat)))) > 0.003;
                const objPosChanged = this.object.position.distanceToSquared(this.lastObjectPos) > 0.001;
                const objRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.object.quaternion.dot(this.lastObjectQuat)))) > 0.003;
                const scaleChanged = this.object.scale.distanceToSquared(this.lastScale) > 0.001;

		if (this.lastExecTime === undefined) this.lastExecTime = time;
		const forceExec = (time - this.lastExecTime) >= 75; // in miliseconds

                if (camPosChanged || camRotChanged || objPosChanged || objRotChanged || scaleChanged || forceExec) {
                        this.updateTileLods(forceExec);
                        if (this.occlusionReady) this.occludeSplatsNow();
                        if (this.filterReady) this.filterSplatsNow();
                        if (this.sortReady) this.sortSplatsNow();

			if (forceExec) this.lastExecTime = time; // reset after forced execution
			else {
				this.lastCameraPos.copy(this.tmpCameraPos);
				this.lastCameraQuat.copy(this.tmpCameraQuat);
				this.lastObjectPos.copy(this.object.position);
				this.lastObjectQuat.copy(this.object.quaternion);
				this.lastScale.copy(this.object.scale);
			}
                }
        },
        updateQuality: function () {
                if (this.isCaching) {
                        if (this.originalBuffers && this.originalBuffers.length > 0) {
                                this.needsQualityUpdate = true;
                        }
                        return;
                }
                if (!this.originalBuffers || this.originalBuffers.length === 0) return;
                this.loadedVertexCount = 0;
                if (this.mesh && this.mesh.geometry) {
                        this.mesh.geometry.instanceCount = 0;
                }
                this.worker.postMessage({ method: "clear" });
                this.centerAndScaleTexture.needsUpdate = true;
                this.covAndColorTexture.needsUpdate = true;
                const buffers = this.originalBuffers;
                const counts = this.originalBufferCounts || [];
                const pushDataBuffer = this.pushDataBuffer;
                const rowLength = this.rowLength;
                for (let i = 0; i < buffers.length; i++) {
                        const buf = buffers[i];
                        const vertexCount = counts[i] || (buf.byteLength / rowLength);
                        pushDataBuffer.call(this, buf, vertexCount);
                }
                this.updateTileLods(true);
                this.sortReady = true;
        },

        // Apply the configured foveation level to the current XR session.
        // A level of 0 disables foveated rendering when supported.
        applyFoveationLevel: function () {
                const renderer = this.el.sceneEl.renderer;
                const session = renderer.xr.getSession?.();
                const level = this.data.foveation;
                if (session && session.renderState && session.renderState.baseLayer) {
                        const baseLayer = session.renderState.baseLayer;
                        if (baseLayer && 'fixedFoveation' in baseLayer) {
                                try {
                                        baseLayer.fixedFoveation = level;
                                } catch (e) {
                                        console.warn('Failed to set fixed foveation', e);
                                }
                                return;
                        }
                }
                if (renderer.xr.setFoveation) {
                        try {
                                renderer.xr.setFoveation(level);
                        } catch (e) {
                                console.warn('Failed to set fixed foveation', e);
                        }
                }
        },
        updateXRScale: function () {
                const renderer = this.el.sceneEl.renderer;
                const session = renderer.xr.getSession?.();
                if (session && typeof XRWebGLLayer !== "undefined") {
                        try {
                                const camera = renderer.xr.getCamera?.();
                                if (camera && camera.views) {
                                        for (const view of camera.views) {
                                                if (view.requestViewportScale) {
                                                        view.requestViewportScale(this.currentXrPixelRatio);
                                                }
                                        }
                                }
                        } catch (e) {
                                console.warn('Failed to execute updateXRScale()', e);
                        }
                } else {
                        renderer.xr.setFramebufferScaleFactor(this.currentXrPixelRatio);
                }
        },
        clampPixelRatio: function (ratio) {
                if (typeof ratio !== 'number') return this.xrPixelRatioBounds.min;
                return Math.min(this.xrPixelRatioBounds.max, Math.max(this.xrPixelRatioBounds.min, ratio));
        },
        resetFrameTiming: function () {
                this.frameTimeSamples = [];
                this.lastDynamicUpdate = 0;
        },
        extractTargetFrameRate: function () {
                const renderer = this.el.sceneEl.renderer;
                const session = renderer.xr.getSession?.();
                if (!session) return this.targetFrameRate;
                const supported = session.supportedFrameRates;
                if (supported && supported.length > 0) {
                        const preferred = supported.includes(90) ? 90 : Math.max(...supported);
                        if (session.updateTargetFrameRate) {
                                session.updateTargetFrameRate(preferred).catch((e) => console.warn('Failed to set target frame rate', e));
                        }
                        return preferred;
                }
                if (session.frameRate) return session.frameRate;
                return this.targetFrameRate;
        },
        isMetaQuestBrowser: function () {
                if (typeof navigator === 'undefined' || !navigator.userAgent) return false;
                return /Quest|OculusBrowser|Oculus.*Quest|Meta Quest/i.test(navigator.userAgent);
        },
        updateDynamicResolution: function (time, timeDelta) {
                if (!this.dynamicResolutionEnabled) return;
                if (!this.el.sceneEl.renderer.xr.isPresenting) return;
                if (!timeDelta || timeDelta <= 0) return;

                this.frameTimeSamples.push(timeDelta);
                if (this.frameTimeSamples.length > 90) {
                        this.frameTimeSamples.shift();
                }

                if (time - this.lastDynamicUpdate < 500) return;
                this.lastDynamicUpdate = time;

                const avgFrameTime = this.frameTimeSamples.reduce((sum, frame) => sum + frame, 0) / this.frameTimeSamples.length;
                const fps = 1000 / avgFrameTime;
                const target = this.targetFrameRate || 72;
                const dropThreshold = target - 5;
                const riseThreshold = target + 5;
                let newRatio = this.currentXrPixelRatio;

                if (fps < dropThreshold) {
                        newRatio = this.clampPixelRatio(this.currentXrPixelRatio - 0.05);
                } else if (fps > riseThreshold) {
                        newRatio = this.clampPixelRatio(this.currentXrPixelRatio + 0.05);
                }

                if (newRatio !== this.currentXrPixelRatio) {
                        this.currentXrPixelRatio = newRatio;
                        this.updateXRScale();
                }
        },

        filterSplatsNow: function () {
                if (!this.filterReady) return;
                this.filterReady = false;
                const viewMatrix = this.getModelViewMatrix();
                const projectionMatrix = this.getProjectionMatrix();
                let camera_mtx = viewMatrix.elements;
                let view = new Float32Array([camera_mtx[2], camera_mtx[6], camera_mtx[10], camera_mtx[14]]);

                const mvpMatrix = new THREE.Matrix4().multiplyMatrices(projectionMatrix, viewMatrix);
                let mvp = new Float32Array(mvpMatrix.elements);

                const globalScale = Math.max(this.object.scale.x, this.object.scale.y, this.object.scale.z);
                let viewport = new THREE.Vector4();
                this.renderer.getCurrentViewport(viewport);
                const focal = (viewport.w / 2.0) * Math.abs(projectionMatrix.elements[5]);
                this.worker.postMessage({ method: "filter", view: view.buffer, mvp: mvp.buffer, scale: globalScale, focal: focal, discard: this.splatsToDiscard }, [view.buffer, mvp.buffer]);
        },

        occludeSplatsNow: function () {
                if (!this.occlusionReady) return;
                this.occlusionReady = false;
                const viewMatrix = this.getModelViewMatrix();
                const projectionMatrix = this.getProjectionMatrix();
                let camera_mtx = viewMatrix.elements;

                let forward = new Float32Array([camera_mtx[2], camera_mtx[6], camera_mtx[10], camera_mtx[14]]);
                let right = new Float32Array([camera_mtx[0], camera_mtx[4], camera_mtx[8]]);
                let up = new Float32Array([camera_mtx[1], camera_mtx[5], camera_mtx[9]]);

                this.camera.getWorldPosition(this.tmpCameraPos);
                this.tmpLocalCameraPos.copy(this.tmpCameraPos);
                this.object.worldToLocal(this.tmpLocalCameraPos);
                let camera = new Float32Array([this.tmpLocalCameraPos.x, this.tmpLocalCameraPos.y, this.tmpLocalCameraPos.z]);

                const mvpMatrix = new THREE.Matrix4().multiplyMatrices(projectionMatrix, viewMatrix);
                let mvp = new Float32Array(mvpMatrix.elements);

                const globalScale = Math.max(this.object.scale.x, this.object.scale.y, this.object.scale.z);
                let viewport = new THREE.Vector4();
                this.renderer.getCurrentViewport(viewport);
                const focal = (viewport.w / 2.0) * Math.abs(projectionMatrix.elements[5]);
                this.occlusionWorker.postMessage({ method: "occlude", forward: forward.buffer, right: right.buffer, up: up.buffer, mvp: mvp.buffer, scale: globalScale, focal: focal, camera: camera.buffer }, [forward.buffer, right.buffer, up.buffer, mvp.buffer, camera.buffer]);
        },

        sortSplatsNow: function () {
                if (!this.sortReady) return;
                this.sortReady = false;
                this.lastCameraMatrix.copy(this.camera.matrixWorld);
                this.lastObjectMatrix.copy(this.object.matrixWorld);
                this.lastScale.copy(this.object.scale);
                this.camera.getWorldPosition(this.lastCameraPos);
                this.camera.getWorldQuaternion(this.lastCameraQuat);
                this.lastObjectPos.copy(this.object.position);
                this.lastObjectQuat.copy(this.object.quaternion);
                this.worker.postMessage({ method: "sort" });
        },
        getProjectionMatrix: function (camera) {
                if (!camera) {
                        camera = this.camera;
                }
                let mtx = camera.projectionMatrix.clone();
		mtx.elements[4] *= -1;
		mtx.elements[5] *= -1;
		mtx.elements[6] *= -1;
		mtx.elements[7] *= -1;
		return mtx;
	},
	getModelViewMatrix: function (camera) {
		if (!camera) {
			camera = this.camera;
		}
		const viewMatrix = camera.matrixWorld.clone();
		viewMatrix.elements[1] *= -1.0;
		viewMatrix.elements[4] *= -1.0;
		viewMatrix.elements[6] *= -1.0;
		viewMatrix.elements[9] *= -1.0;
		viewMatrix.elements[13] *= -1.0;
		const mtx = this.object.matrixWorld.clone();
		mtx.invert();
		mtx.elements[1] *= -1.0;
		mtx.elements[4] *= -1.0;
		mtx.elements[6] *= -1.0;
		mtx.elements[9] *= -1.0;
		mtx.elements[13] *= -1.0;
                mtx.multiply(viewMatrix);
                mtx.invert();
                return mtx;
        },

        matricesEqual: function (a, b, epsilon = 1e-3) {
                for (let i = 0; i < 16; i++) {
                        if (Math.abs(a.elements[i] - b.elements[i]) > epsilon) return false;
                }
                return true;
        },
        createWorker: function (self) {
                let matrices = undefined;
                let activeIndices = null;
                let normals = undefined;
                let fadeOpacities = undefined;
                let pendingActive = null;

                const COUNT_SIZE = 1200 * 1200;
                const toUint32Array = (data) => {
                        if (!data) return null;
                        if (data instanceof Uint32Array) return data;
                        if (ArrayBuffer.isView(data)) {
                                return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
                        }
                        if (data instanceof ArrayBuffer) return new Uint32Array(data);
                        return new Uint32Array(data);
                };

                let cache = {
                        capacity: 0,
                        depthList: null,
                        sizeList: null,
                        validIndexList: null,
                };

                const counts0 = new Uint32Array(COUNT_SIZE);
                const starts0 = new Uint32Array(COUNT_SIZE);
                let filterResult = { count: 0, minDepth: 0, maxDepth: 0 };
                let discardMark = null;
                let wasOccluded = null;

                const ensureCapacity = (n) => {
                        if (cache.capacity >= n) return;
                        cache.capacity = n;
                        cache.depthList = new Float32Array(n);
                        cache.sizeList = new Int32Array(cache.depthList.buffer);
                        cache.validIndexList = new Int32Array(n);
                        discardMark = new Uint8Array(n);
                };
                const applyActiveList = (indices, vertexCount) => {
                        if (!indices) {
                                activeIndices = null;
                                return;
                        }
                        if (indices.length === 0) {
                                activeIndices = new Uint32Array(0);
                                return;
                        }
                        activeIndices = indices;
                };

                const filterSplats = function filterSplats(matrices, view, mvp, scaleFactor = 1.0, focal = 1.0) {
                        const vertexCount = matrices.length / 16;
                        if (!wasOccluded || !fadeOpacities || fadeOpacities.length < vertexCount) {
                                const tmp = new Float32Array(vertexCount);
                                tmp.fill(2.0);
                                if (fadeOpacities) tmp.set(fadeOpacities.subarray(0, Math.min(fadeOpacities.length, vertexCount)));
                                fadeOpacities = tmp;

				wasOccluded = new Uint8Array(vertexCount);
                        }

                        ensureCapacity(vertexCount);

                        let maxDepth = -Infinity;
                        let minDepth = Infinity;
                        let depthList = cache.depthList;
                        let sizeList = cache.sizeList;
                        let validIndexList = cache.validIndexList;
                        let validCount = 0;

                        // cache matrix values locally for speed
                        const v0 = view[0], v1 = view[1], v2 = view[2], v3 = view[3];
                        const m0 = mvp[0],  m1 = mvp[1],  m2 = mvp[2],  m3 = mvp[3];
                        const m4 = mvp[4],  m5 = mvp[5],  m6 = mvp[6],  m7 = mvp[7];
                        const m8 = mvp[8],  m9 = mvp[9],  m10 = mvp[10], m11 = mvp[11];
                        const m12 = mvp[12], m13 = mvp[13], m14 = mvp[14], m15 = mvp[15];

                        const fadeStep = 0.12;
                        const nearPlaneClip = -0.08;
                        const useActive = activeIndices !== null;
                        const loopCount = useActive ? activeIndices.length : vertexCount;
                        for (let i = 0; i < loopCount; i++) {
                                const idx = useActive ? activeIndices[i] : i;
                                const offset = idx * 16;
                                //if (discardMark[i]) continue;

                                const px = matrices[offset + 12];
                                const py = matrices[offset + 13];
                                const pz = matrices[offset + 14];

                                const clip_x = m0 * px + m4 * py + m8  * pz + m12;
                                const clip_y = m1 * px + m5 * py + m9  * pz + m13;
                                const clip_z = m2 * px + m6 * py + m10 * pz + m14;
                                const clip_w = m3 * px + m7 * py + m11 * pz + m15;

				const radius = matrices[offset + 15] * scaleFactor;
                                const transparency = matrices[offset + 11]; // 0-1
                                const radiusTransparencyProduct = radius * transparency;
                                
                                const skipCullEdges = (radiusTransparencyProduct / scaleFactor) > 0.075;
				const skipCullBehind = (radiusTransparencyProduct / scaleFactor) > 0.3;

                                if (clip_w < 0.0 && !skipCullBehind) continue;

                                const invW  = 1.0 / clip_w;

                                const ndcX  = clip_x * invW;
                                const ndcY  = clip_y * invW;
                                const ndcZ  = clip_z * invW;

                                let depth = v0 * px + v1 * py + v2 * pz + v3;
				
				const insideOfScreen = ndcX >= -1.0 && ndcX <= 1.0 && ndcY >= -1.0 && ndcY <= 1.0;

				if (!insideOfScreen && !skipCullEdges) continue;

                                if (depth + radius > nearPlaneClip && insideOfScreen) {
                                        continue; // centre is inside the view and too close to the camera
                                }

                                const edgeDist = Math.max(Math.abs(ndcX), Math.abs(ndcY));
                                const edgeMultiplier = 1.0 + (edgeDist * 0.5);
                                
                                const pixelThreshold = (focal * radiusTransparencyProduct) / -depth;
                                const tooSmall = pixelThreshold < 0.6 * edgeMultiplier && !skipCullBehind;

                                let f = fadeOpacities[idx];

				if (insideOfScreen) {
					const isOccluded = discardMark && discardMark[idx] === 1;
					const was = wasOccluded[idx] === 1;

					if (f === 2.0) f = (isOccluded || tooSmall) ? 0.0 : 1.0; // default unset value is 2.0

					if (tooSmall) f = Math.max(0, f - fadeStep);
					
					else if (isOccluded) f = Math.max(0, f - fadeStep);

					else {
						const step = was ? fadeStep * 3.0 : fadeStep;
						f = Math.min(1, f + step);
					}

					if (isOccluded)
						wasOccluded[idx] = 1;
					else if (was && f >= 1.0 - fadeStep)
						wasOccluded[idx] = 0;
                                }
				else
				{
                                	f = 2.0;
                                        wasOccluded[idx] = 0;
				}

				fadeOpacities[idx] = f;

                                if (f < 0.20) continue;

                                depthList[validCount] = depth;
                                validIndexList[validCount] = idx;
                                validCount++;
                                if (depth > maxDepth) maxDepth = depth;
                                if (depth < minDepth) minDepth = depth;
                        }

			console.warn(validCount);

                        filterResult.count = validCount;
                        filterResult.minDepth = minDepth;
                        filterResult.maxDepth = maxDepth;
                };

                const sortSplats = function sortSplats() {
                        const validCount = filterResult.count;
                        let depthList = cache.depthList;
                        let sizeList = cache.sizeList;
                        let validIndexList = cache.validIndexList;
                        if (validCount === 0) {
                                return new Uint32Array(0);
                        }

                        let maxDepth = filterResult.maxDepth;
                        let minDepth = filterResult.minDepth;

                        let depthInv = (COUNT_SIZE - 1) / (maxDepth - minDepth);
                        counts0.fill(0);
                        for (let i = 0; i < validCount; i++) {
                                sizeList[i] = ((depthList[i] - minDepth) * depthInv) | 0;
                                counts0[sizeList[i]]++;
                        }
                        starts0[0] = 0;
                        for (let i = 1; i < COUNT_SIZE; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
                        let depthIndex = new Uint32Array(validCount);
                        for (let i = 0; i < validCount; i++) depthIndex[starts0[sizeList[i]]++] = validIndexList[i];

                        return depthIndex;
                };

		self.onmessage = (e) => {
                        if (e.data.method == "clear") {
                                matrices = undefined;
                                fadeOpacities = undefined;
                                discardMark = null;
                                activeIndices = null;
                                pendingActive = null;
                        }
                        if (e.data.method == "push") {
                                new_matrices = new Float32Array(e.data.matrices);
                                const newFade = new Float32Array(new_matrices.length / 16);
                                newFade.fill(2.0);
                                if (matrices === undefined) {
                                        matrices = new_matrices;
                                        fadeOpacities = newFade;
                                } else {
                                        resized = new Float32Array(matrices.length + new_matrices.length);
                                        resized.set(matrices);
                                        resized.set(new_matrices, matrices.length);
                                        matrices = resized;

                                        let fadeResized = new Float32Array(fadeOpacities.length + newFade.length);
                                        fadeResized.set(fadeOpacities);
                                        fadeResized.set(newFade, fadeOpacities.length);
                                        fadeOpacities = fadeResized;
                                }
                                if (pendingActive && matrices) {
                                        applyActiveList(pendingActive, matrices.length / 16);
                                        pendingActive = null;
                                }
                        }
                        if (e.data.method == "setActive") {
                                const indices = toUint32Array(e.data.active);
                                if (matrices) {
                                        applyActiveList(indices, matrices.length / 16);
                                } else {
                                        pendingActive = indices;
                                }
                        }
                        if (e.data.method == "filter") {
                                if (matrices !== undefined) {
                                        ensureCapacity(matrices.length / 16);
                                        const vertexCount = matrices.length / 16;
                                        discardMark.fill(0, 0, vertexCount);
                                        const discarded = e.data.discard ? new Uint32Array(e.data.discard) : null;
                                        if (discarded) {
                                                for (let i = 0; i < discarded.length; i++) {
                                                        const idx = discarded[i];
                                                        if (idx < vertexCount) discardMark[idx] = 1;
                                                }
                                        }
                                        const view = new Float32Array(e.data.view);
                                        const mvp = new Float32Array(e.data.mvp);
                                        const scaleFactor = typeof e.data.scale === 'number' ? e.data.scale : 1.0;
                                        const focal = typeof e.data.focal === 'number' ? e.data.focal : 1.0;
                                        filterSplats(matrices, view, mvp, scaleFactor, focal);
                                }
                                self.postMessage({ method: "filter" });
                        }
                        if (e.data.method == "sort") {
                               if (matrices === undefined) {
                                       const sortedIndexes = new Uint32Array(1);
                                       const fadeCopy = new Uint8Array(1);
                                       fadeCopy[0] = 2.0;
                                       self.postMessage({ method: "sort", sortedIndexes, fadeOpacities: fadeCopy }, [sortedIndexes.buffer, fadeCopy.buffer]);
                               } else {
                                       const sortedIndexes = sortSplats();
                                       const fadeCopy = new Uint8Array(sortedIndexes.length);
                                       for (let i = 0; i < sortedIndexes.length; i++) {
                                               const f = fadeOpacities[sortedIndexes[i]];
                                               fadeCopy[i] = Math.round(Math.max(0, Math.min(1, f < 0 ? 1 : f)) * 255);
                                       }
                                       self.postMessage({ method: "sort", sortedIndexes, fadeOpacities: fadeCopy }, [sortedIndexes.buffer, fadeCopy.buffer]);
                               }
                        }
                };
        },
        createOcclusionWorker: function (self) {
                let matrices = undefined;
                let activeIndices = null;

                const COUNT_SIZE = 256 * 256;
                const toUint32Array = (data) => {
                        if (!data) return null;
                        if (data instanceof Uint32Array) return data;
                        if (ArrayBuffer.isView(data)) {
                                return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
                        }
                        if (data instanceof ArrayBuffer) return new Uint32Array(data);
                        return new Uint32Array(data);
                };

                let cache = {
                        capacity: 0,
                        depthList: null,
                        sizeList: null,
                        validIndexList: null,
                };

                const counts0 = new Uint32Array(COUNT_SIZE);
                const starts0 = new Uint32Array(COUNT_SIZE);

                const GRID_SIZE = 2048;
                const grid = new Float32Array(GRID_SIZE * GRID_SIZE);

                const ensureCapacity = (n) => {
                        if (cache.capacity >= n) return;
                        cache.capacity = n;
                        cache.depthList = new Float32Array(n);
                        cache.sizeList = new Int32Array(cache.depthList.buffer);
                        cache.validIndexList = new Int32Array(n);
                };

                const occludeSplats = function occludeSplats(matrices, forward, right, up, mvp, scaleFactor = 1.0, focal = 1.0, camera = null) {
                        const vertexCount = matrices.length / 16;
                        ensureCapacity(vertexCount);
                        const hasNormals = !!normals && normals.length >= vertexCount * 3;
                        const hasCamera = !!camera && camera.length >= 3;
                        const cameraX = hasCamera ? camera[0] : 0;
                        const cameraY = hasCamera ? camera[1] : 0;
                        const cameraZ = hasCamera ? camera[2] : 0;
                        let maxDepth = -Infinity;
                        let minDepth = Infinity;
                        let depthList = cache.depthList;
                        let sizeList = cache.sizeList;
                        let validIndexList = cache.validIndexList;
                        let validCount = 0;

                        // cache matrix values locally for speed
                        const f0 = forward[0], f1 = forward[1], f2 = forward[2], f3 = forward[3];
                        const r0 = right[0],   r1 = right[1],   r2 = right[2];
                        const u0 = up[0],      u1 = up[1],      u2 = up[2];
                        const m0 = mvp[0],  m1 = mvp[1],  m2 = mvp[2],  m3 = mvp[3];
                        const m4 = mvp[4],  m5 = mvp[5],  m6 = mvp[6],  m7 = mvp[7];
                        const m8 = mvp[8],  m9 = mvp[9],  m10 = mvp[10], m11 = mvp[11];
                        const m12 = mvp[12], m13 = mvp[13], m14 = mvp[14], m15 = mvp[15];

                        const useActive = activeIndices !== null;
                        const loopCount = useActive ? activeIndices.length : vertexCount;
                        for (let i = 0; i < loopCount; i++) {
                                const idx = useActive ? activeIndices[i] : i;
                                const offset = idx * 16;
                                const px = matrices[offset + 12];
                                const py = matrices[offset + 13];
                                const pz = matrices[offset + 14];

                                const clip_x = m0 * px + m4 * py + m8  * pz + m12;
                                const clip_y = m1 * px + m5 * py + m9  * pz + m13;
                                const clip_z = m2 * px + m6 * py + m10 * pz + m14;
                                const clip_w = m3 * px + m7 * py + m11 * pz + m15;

                                const depth = f0 * px + f1 * py + f2 * pz + f3;

                                depthList[validCount] = depth;
                                validIndexList[validCount] = idx;
                                validCount++;
                                if (depth > maxDepth) maxDepth = depth;
                                if (depth < minDepth) minDepth = depth;
                        }

                        if (validCount === 0) {
                                return new Uint32Array(0);
                        }

                        let depthInv = (COUNT_SIZE - 1) / (maxDepth - minDepth);
                        counts0.fill(0);
                        for (let i = 0; i < validCount; i++) {
                                sizeList[i] = ((depthList[i] - minDepth) * depthInv) | 0;
                                counts0[sizeList[i]]++;
                        }
                        starts0[0] = 0;
                        for (let i = 1; i < COUNT_SIZE; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
                        let depthIndex = new Uint32Array(validCount);
                        for (let i = 0; i < validCount; i++) depthIndex[starts0[sizeList[i]]++] = validIndexList[i];

                        // Occlusion accumulation using a screen space grid
                        grid.fill(1.0); // remaining transparency for each cell
                        const discarded = new Uint32Array(validCount);
                        let discardCount = 0;

                        const nearPlaneClip = -0.08;

                        for (let di = validCount - 1; di >= 0; di--) {
                                const idx = depthIndex[di];
                                const offset = idx * 16;
                                
                                const px = matrices[offset + 12];
                                const py = matrices[offset + 13];
                                const pz = matrices[offset + 14];

                                const clip_w = m3 * px + m7 * py + m11 * pz + m15;
                                if (clip_w <= 0.0) continue;
                                
                                const maxRadius = matrices[offset + 15];
                                if (maxRadius > 0.2) continue;

                                const depth = f0 * px + f1 * py + f2 * pz + f3;
                                if (depth >= 0.0) continue;

                                if (depth + maxRadius > nearPlaneClip) {
                                        continue; // centre is inside the view and too close to the camera
                                }

                                const clip_x = m0 * px + m4 * py + m8  * pz + m12;
                                const clip_y = m1 * px + m5 * py + m9  * pz + m13;
                                const clip_z = m2 * px + m6 * py + m10 * pz + m14;

                                const invW  = 1.0 / clip_w;
                                const ndcX  = clip_x * invW;
                                const ndcY  = clip_y * invW;

                                const insideOfScreen = ndcX >= -1.0 && ndcX <= 1.0 && ndcY >= -1.0 && ndcY <= 1.0;
                                if (!insideOfScreen) continue;

                                const radius = scaleFactor * maxRadius;
                                const opacity = matrices[offset + 11]; // 0-1 (0 transparent, 1 opaque)

                                const radiusTransparencyProduct = radius * opacity;
                                const skipCullBehind = (radiusTransparencyProduct / scaleFactor) > 0.3;

                                const edgeDist = Math.max(Math.abs(ndcX), Math.abs(ndcY));
                                const edgeMultiplier = 1.0 + (edgeDist * 0.5);

                                const pixelThreshold = (focal * radiusTransparencyProduct) / -depth;
                                const tooSmall = pixelThreshold < 0.6 * edgeMultiplier && !skipCullBehind;

                                if (tooSmall) continue;

                                const c00 = matrices[offset + 0], c01 = matrices[offset + 4], c02 = matrices[offset + 8];
                                const c10 = matrices[offset + 1], c11 = matrices[offset + 5], c12 = matrices[offset + 9];
                                const c20 = matrices[offset + 2], c21 = matrices[offset + 6], c22 = matrices[offset + 10];

                                const rCx = c00 * r0 + c01 * r1 + c02 * r2;
                                const rCy = c10 * r0 + c11 * r1 + c12 * r2;
                                const rCz = c20 * r0 + c21 * r1 + c22 * r2;
                                const radiusX = Math.sqrt(r0 * rCx + r1 * rCy + r2 * rCz);

                                const uCx = c00 * u0 + c01 * u1 + c02 * u2;
                                const uCy = c10 * u0 + c11 * u1 + c12 * u2;
                                const uCz = c20 * u0 + c21 * u1 + c22 * u2;
                                const radiusY = Math.sqrt(u0 * uCx + u1 * uCy + u2 * uCz);

                                const ndcRadiusX = radiusX / -depth;
                                const ndcRadiusY = radiusY / -depth;
                                const gridX = (ndcX * 0.5 + 0.5) * GRID_SIZE;
                                const gridY = (ndcY * 0.5 + 0.5) * GRID_SIZE;
                                const gridRadiusX = ndcRadiusX * (GRID_SIZE * 0.5);
                                const gridRadiusY = ndcRadiusY * (GRID_SIZE * 0.5);

                                const x0 = Math.max(0, Math.floor(gridX - gridRadiusX));
                                const y0 = Math.max(0, Math.floor(gridY - gridRadiusY));
                                const x1 = Math.min(GRID_SIZE - 1, Math.ceil(gridX + gridRadiusX));
                                const y1 = Math.min(GRID_SIZE - 1, Math.ceil(gridY + gridRadiusY));
                                if (x1 <= 0 || x1 < x0 || y1 <= 0 || y1 < y0 || x0 >= GRID_SIZE || y0 >= GRID_SIZE) continue;

				let facingFactor = 1.0;
                                if (hasNormals && hasCamera) {
                                        const nx = normals[idx * 3 + 0];
                                        const ny = normals[idx * 3 + 1];
                                        const nz = normals[idx * 3 + 2];
                                        const toCameraX = cameraX - px;
                                        const toCameraY = cameraY - py;
                                        const toCameraZ = cameraZ - pz;
                                        const distSq = toCameraX * toCameraX + toCameraY * toCameraY + toCameraZ * toCameraZ;
                                        if (distSq > 1.0) {
                                        	const invLen = 1.0 / Math.sqrt(distSq);
                                        	const dot = (nx * toCameraX + ny * toCameraY + nz * toCameraZ) * invLen;
                                                const clampedDot = Math.min(1.0, Math.max(-1.0, dot));
                                        	facingFactor = 1.0 - Math.max(0.0, clampedDot);
					}
                                }

                                let residual = 0.0;
                                let cells = 0;
                                for (let y = y0; y <= y1; y++) {
                                        const row = y * GRID_SIZE;
                                        for (let x = x0; x <= x1; x++) {
                                                residual += grid[row + x];
                                                cells++;
                                        }
                                }
                                const avgResidual = residual / cells;

                                const perceived = opacity * (avgResidual ** 0.5);
                                if (perceived < 0.00001) {
                                        discarded[discardCount++] = idx;
                                }

                                const attenuation = 1.0 - opacity;
                                for (let y = y0; y <= y1; y++) {
                                        const row = y * GRID_SIZE;
                                        for (let x = x0; x <= x1; x++) {
                                                grid[row + x] *= attenuation * (facingFactor * facingFactor);
                                        }
                                }
                        }

                        return discarded.subarray(0, discardCount);
                };

                self.onmessage = (e) => {
                        if (e.data.method == "clear") {
                                matrices = undefined;
                                normals = undefined;
                                activeIndices = null;
                        }
                        if (e.data.method == "push") {
                                const new_matrices = new Float32Array(e.data.matrices);
                                const new_normals = e.data.normals ? new Float32Array(e.data.normals) : undefined;
                                if (matrices === undefined) {
                                        matrices = new_matrices;
                                } else {
                                        const resized = new Float32Array(matrices.length + new_matrices.length);
                                        resized.set(matrices);
                                        resized.set(new_matrices, matrices.length);
                                        matrices = resized;
                                }
                                if (new_normals) {
                                        if (normals === undefined) {
                                                normals = new_normals;
                                        } else {
                                                const resizedNormals = new Float32Array(normals.length + new_normals.length);
                                                resizedNormals.set(normals);
                                                resizedNormals.set(new_normals, normals.length);
                                                normals = resizedNormals;
                                        }
                                } else {
                                        normals = undefined;
                                }
                        }
                        if (e.data.method == "setActive") {
                                activeIndices = toUint32Array(e.data.active);
                        }
                        if (e.data.method == "occlude") {
                                let discard = new Uint32Array(0);
                                if (matrices !== undefined) {
                                        const forward = new Float32Array(e.data.forward);
                                        const right = new Float32Array(e.data.right);
                                        const up = new Float32Array(e.data.up);
                                        const mvp = new Float32Array(e.data.mvp);
                                        const scaleFactor = typeof e.data.scale === 'number' ? e.data.scale : 1.0;
                                        const focal = typeof e.data.focal === 'number' ? e.data.focal : 1.0;
                                        const camera = e.data.camera ? new Float32Array(e.data.camera) : null;
                                        discard = occludeSplats(matrices, forward, right, up, mvp, scaleFactor, focal, camera);
                                }
                                self.postMessage({ method: "occlude", discard }, [discard.buffer]);
                        }
                };
        },
       parsePlyHeader: function (inputBuffer) {
               const ubuf = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer);
               const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
               let header_end = "end_header\n";
               let header_end_index = header.indexOf(header_end);
               if (header_end_index < 0) {
                       header_end = "end_header\r\n";
                       header_end_index = header.indexOf(header_end);
               }
               if (header_end_index < 0) {
                       return null;
               }
               const formatMatch = /format (ascii|binary_little_endian) 1\.0/.exec(header);
               const format = formatMatch ? formatMatch[1] : "binary_little_endian";
               const vertexMatch = /element vertex (\d+)/.exec(header);
               const vertexCount = vertexMatch ? parseInt(vertexMatch[1]) : 0;
               let row_offset = 0;
               const offsets = {};
               const types = {};
               const TYPE_MAP = {
                       double: { method: "getFloat64", size: 8 },
                       int: { method: "getInt32", size: 4 },
                       uint: { method: "getUint32", size: 4 },
                       float: { method: "getFloat32", size: 4 },
                       short: { method: "getInt16", size: 2 },
                       ushort: { method: "getUint16", size: 2 },
                       uchar: { method: "getUint8", size: 1 },
                       char: { method: "getInt8", size: 1 },
               };
               for (let prop of header
                       .slice(0, header_end_index)
                       .split(/\r?\n/)
                       .filter((k) => k.startsWith("property "))) {
                       const [, type, name] = prop.split(" ");
                       const info = TYPE_MAP[type] || { method: "getInt8", size: 1 };
                       types[name] = info.method;
                       offsets[name] = row_offset;
                       row_offset += info.size;
               }
               return {
                       format,
                       vertexCount,
                       rowOffset: row_offset,
                       offsets,
                       types,
                       headerByteLength: header_end_index + header_end.length,
               };
       },
       buildPlyBinaryBatch: function (plyState, pending, rowCount) {
               const rowLength = this.rowLength;
               const dataView = new DataView(
                       pending.buffer,
                       pending.byteOffset,
                       rowCount * plyState.rowOffset,
               );
               const buffer = new ArrayBuffer(rowLength * rowCount);
               const outFloats = new Float32Array(buffer);
               const outBytes = new Uint8Array(buffer);
               if (!this.plyReaders) {
                       this.plyReaders = {
                               getFloat64: (dv, offset) => dv.getFloat64(offset, true),
                               getInt32: (dv, offset) => dv.getInt32(offset, true),
                               getUint32: (dv, offset) => dv.getUint32(offset, true),
                               getFloat32: (dv, offset) => dv.getFloat32(offset, true),
                               getInt16: (dv, offset) => dv.getInt16(offset, true),
                               getUint16: (dv, offset) => dv.getUint16(offset, true),
                               getUint8: (dv, offset) => dv.getUint8(offset),
                               getInt8: (dv, offset) => dv.getInt8(offset),
                       };
               }
               const readers = this.plyReaders;
               const offsets = plyState.offsets;
               const types = plyState.types;
               const hasScale = Boolean(types["scale_0"]);
               const hasRotation = Boolean(types["rot_0"]);
               const hasOpacity = Boolean(types["opacity"]);
               const hasFdc = Boolean(types["f_dc_0"]);
               const hasRgb = Boolean(types["red"]);
               const xMethod = types["x"];
               const yMethod = types["y"];
               const zMethod = types["z"];
               const scale0Method = types["scale_0"];
               const scale1Method = types["scale_1"];
               const scale2Method = types["scale_2"];
               const opacityMethod = types["opacity"];
               const rot0Method = types["rot_0"];
               const rot1Method = types["rot_1"];
               const rot2Method = types["rot_2"];
               const rot3Method = types["rot_3"];
               const fdc0Method = types["f_dc_0"];
               const fdc1Method = types["f_dc_1"];
               const fdc2Method = types["f_dc_2"];
               const redMethod = types["red"];
               const greenMethod = types["green"];
               const blueMethod = types["blue"];
               const getX = xMethod ? readers[xMethod] : null;
               const getY = yMethod ? readers[yMethod] : null;
               const getZ = zMethod ? readers[zMethod] : null;
               const getScale0 = scale0Method ? readers[scale0Method] : null;
               const getScale1 = scale1Method ? readers[scale1Method] : null;
               const getScale2 = scale2Method ? readers[scale2Method] : null;
               const getOpacity = opacityMethod ? readers[opacityMethod] : null;
               const getRot0 = rot0Method ? readers[rot0Method] : null;
               const getRot1 = rot1Method ? readers[rot1Method] : null;
               const getRot2 = rot2Method ? readers[rot2Method] : null;
               const getRot3 = rot3Method ? readers[rot3Method] : null;
               const getFdc0 = fdc0Method ? readers[fdc0Method] : null;
               const getFdc1 = fdc1Method ? readers[fdc1Method] : null;
               const getFdc2 = fdc2Method ? readers[fdc2Method] : null;
               const getRed = redMethod ? readers[redMethod] : null;
               const getGreen = greenMethod ? readers[greenMethod] : null;
               const getBlue = blueMethod ? readers[blueMethod] : null;
               const xOffset = offsets["x"] || 0;
               const yOffset = offsets["y"] || 0;
               const zOffset = offsets["z"] || 0;
               const scale0Offset = offsets["scale_0"] || 0;
               const scale1Offset = offsets["scale_1"] || 0;
               const scale2Offset = offsets["scale_2"] || 0;
               const opacityOffset = offsets["opacity"] || 0;
               const rot0Offset = offsets["rot_0"] || 0;
               const rot1Offset = offsets["rot_1"] || 0;
               const rot2Offset = offsets["rot_2"] || 0;
               const rot3Offset = offsets["rot_3"] || 0;
               const fdc0Offset = offsets["f_dc_0"] || 0;
               const fdc1Offset = offsets["f_dc_1"] || 0;
               const fdc2Offset = offsets["f_dc_2"] || 0;
               const redOffset = offsets["red"] || 0;
               const greenOffset = offsets["green"] || 0;
               const blueOffset = offsets["blue"] || 0;
               const IMPORTANCE_THRESHOLD = 0.0015;
               const SH_C0 = 0.28209479177387814;
               const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
               const exp = Math.exp;
               const sqrt = Math.sqrt;
               let writeIndex = 0;
               for (let row = 0; row < rowCount; row++) {
                       const rowByteOffset = row * plyState.rowOffset;
                       const x = getX ? getX(dataView, rowByteOffset + xOffset) : 0;
                       const y = getY ? getY(dataView, rowByteOffset + yOffset) : 0;
                       const z = getZ ? getZ(dataView, rowByteOffset + zOffset) : 0;
                       let s0 = 0.01;
                       let s1 = 0.01;
                       let s2 = 0.01;
                       let opacity = 1;
                       if (hasScale) {
                               s0 = exp(getScale0 ? getScale0(dataView, rowByteOffset + scale0Offset) : 0);
                               s1 = exp(getScale1 ? getScale1(dataView, rowByteOffset + scale1Offset) : 0);
                               s2 = exp(getScale2 ? getScale2(dataView, rowByteOffset + scale2Offset) : 0);
                               if (hasOpacity) {
                                       const rawOpacity = getOpacity ? getOpacity(dataView, rowByteOffset + opacityOffset) : 0;
                                       opacity = 1 / (1 + Math.exp(-rawOpacity));
                               }
                               const size = s0 * s1 * s2;
                               const opacityCubed = opacity * opacity * opacity;
                               const importance = sqrt(sqrt(size * opacityCubed));
                               if (importance < IMPORTANCE_THRESHOLD) {
                                       continue;
                               }
                       } else if (hasOpacity) {
                               const rawOpacity = getOpacity ? getOpacity(dataView, rowByteOffset + opacityOffset) : 0;
                               opacity = 1 / (1 + Math.exp(-rawOpacity));
                       }
                       const floatIndex = (writeIndex * rowLength) / 4;
                       outFloats[floatIndex] = x;
                       outFloats[floatIndex + 1] = y;
                       outFloats[floatIndex + 2] = z;
                       outFloats[floatIndex + 3] = s0;
                       outFloats[floatIndex + 4] = s1;
                       outFloats[floatIndex + 5] = s2;

                       const byteIndex = writeIndex * rowLength;
                       if (hasRotation) {
                               const r0 = getRot0 ? getRot0(dataView, rowByteOffset + rot0Offset) : 0;
                               const r1 = getRot1 ? getRot1(dataView, rowByteOffset + rot1Offset) : 0;
                               const r2 = getRot2 ? getRot2(dataView, rowByteOffset + rot2Offset) : 0;
                               const r3 = getRot3 ? getRot3(dataView, rowByteOffset + rot3Offset) : 0;
                               const qlen = sqrt(r0 ** 2 + r1 ** 2 + r2 ** 2 + r3 ** 2) || 1;
                               outBytes[byteIndex + 28] = clampByte((r0 / qlen) * 128 + 128);
                               outBytes[byteIndex + 29] = clampByte((r1 / qlen) * 128 + 128);
                               outBytes[byteIndex + 30] = clampByte((r2 / qlen) * 128 + 128);
                               outBytes[byteIndex + 31] = clampByte((r3 / qlen) * 128 + 128);
                       } else {
                               outBytes[byteIndex + 28] = 255;
                               outBytes[byteIndex + 29] = 0;
                               outBytes[byteIndex + 30] = 0;
                               outBytes[byteIndex + 31] = 0;
                       }

                       if (hasFdc) {
                               outBytes[byteIndex + 24] = clampByte((0.5 + SH_C0 * (getFdc0 ? getFdc0(dataView, rowByteOffset + fdc0Offset) : 0)) * 255);
                               outBytes[byteIndex + 25] = clampByte((0.5 + SH_C0 * (getFdc1 ? getFdc1(dataView, rowByteOffset + fdc1Offset) : 0)) * 255);
                               outBytes[byteIndex + 26] = clampByte((0.5 + SH_C0 * (getFdc2 ? getFdc2(dataView, rowByteOffset + fdc2Offset) : 0)) * 255);
                       } else if (hasRgb) {
                               outBytes[byteIndex + 24] = clampByte(getRed ? getRed(dataView, rowByteOffset + redOffset) : 0);
                               outBytes[byteIndex + 25] = clampByte(getGreen ? getGreen(dataView, rowByteOffset + greenOffset) : 0);
                               outBytes[byteIndex + 26] = clampByte(getBlue ? getBlue(dataView, rowByteOffset + blueOffset) : 0);
                       } else {
                               outBytes[byteIndex + 24] = 0;
                               outBytes[byteIndex + 25] = 0;
                               outBytes[byteIndex + 26] = 0;
                       }
                       outBytes[byteIndex + 27] = clampByte(opacity * 255);
                       writeIndex++;
               }
               return {
                       buffer: writeIndex === rowCount ? buffer : buffer.slice(0, writeIndex * rowLength),
                       vertexCount: writeIndex,
               };
       },
       processPlyBuffer: function (inputBuffer) {
               const ubuf = new Uint8Array(inputBuffer);
               // 10KB ought to be enough for a header...
               const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
               let header_end = "end_header\n";
               let header_end_index = header.indexOf(header_end);
               if (header_end_index < 0) {
                       header_end = "end_header\r\n";
                       header_end_index = header.indexOf(header_end);
               }
               if (header_end_index < 0)
                       throw new Error("Unable to read .ply file header");
               const formatMatch = /format (ascii|binary_little_endian) 1\.0/.exec(header);
               const format = formatMatch ? formatMatch[1] : "binary_little_endian";
               let vertexCount = parseInt(/element vertex (\d+)/.exec(header)[1]);
               let row_offset = 0,
                       offsets = {},
                       types = {},
                       propertyOrder = [];
               const TYPE_MAP = {
                       double: "getFloat64",
                       int: "getInt32",
                       uint: "getUint32",
                       float: "getFloat32",
                       short: "getInt16",
                       ushort: "getUint16",
                       uchar: "getUint8",
               };
               for (let prop of header
                       .slice(0, header_end_index)
                       .split(/\r?\n/)
                       .filter((k) => k.startsWith("property "))) {
                       const [p, type, name] = prop.split(" ");
                       const arrayType = TYPE_MAP[type] || "getInt8";
                       types[name] = arrayType;
                       offsets[name] = row_offset;
                       row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
                       propertyOrder.push(name);
               }

               const rowLength = 3 * 4 + 3 * 4 + 4 + 4;

               if (format === "ascii") {
                       const bodyStr = new TextDecoder().decode(
                               ubuf.slice(header_end_index + header_end.length),
                       );
                       const lines = bodyStr.split(/\r?\n/);
                       const vertices = [];
                       for (let line of lines) {
                               if (vertices.length >= vertexCount) break;
                               line = line.trim();
                               if (!line) continue;
                               const parts = line.split(/\s+/);
                               if (parts.length < propertyOrder.length) continue;
                               const attrs = {};
                               let valid = true;
                               for (let i = 0; i < propertyOrder.length; i++) {
                                       const value = Number(parts[i]);
                                       if (!Number.isFinite(value)) {
                                               valid = false;
                                               break;
                                       }
                                       attrs[propertyOrder[i]] = value;
                               }
                               if (!valid) continue;
                               vertices.push(attrs);
                       }
                       vertexCount = vertices.length;

                       const IMPORTANCE_THRESHOLD = 0.0015;
                       let sizeList = [];
                       let sizeIndex = [];
                       for (let i = 0; i < vertexCount; i++) {
                               const a = vertices[i];
                               if (!("scale_0" in a)) {
                                       sizeIndex.push(i);
                                       sizeList.push(0);
                                       continue;
                               }

                               const s0 = Math.exp(a.scale_0);
                               const s1 = Math.exp(a.scale_1);
                               const s2 = Math.exp(a.scale_2);

                               //const minScale = Math.min(s0, s1, s2);
                               //const maxScale = Math.max(s0, s1, s2);

                               const size = Math.exp(s0) * Math.exp(s1) * Math.exp(s2);

                               const opacity = "opacity" in a ? 1 / (1 + Math.exp(-a.opacity)) : 1;
                               const importance = Math.pow(size * opacity ** 3, 1/4);
                               if (importance < IMPORTANCE_THRESHOLD) continue;

                               sizeIndex.push(i);
                               sizeList.push(importance);
                       }
                       sizeIndex = new Uint32Array(sizeIndex);
                       sizeList = new Float32Array(sizeList);
                       vertexCount = sizeIndex.length;
                       sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);

                       const buffer = new ArrayBuffer(rowLength * vertexCount);
                       for (let j = 0; j < vertexCount; j++) {
                               const a = vertices[sizeIndex[j]];
                               const position = new Float32Array(buffer, j * rowLength, 3);
                               const scales = new Float32Array(buffer, j * rowLength + 12, 3);
                               const rgba = new Uint8ClampedArray(buffer, j * rowLength + 24, 4);
                               const rot = new Uint8ClampedArray(buffer, j * rowLength + 28, 4);

                               position[0] = a.x || 0;
                               position[1] = a.y || 0;
                               position[2] = a.z || 0;

                               if ("scale_0" in a) {
                                       const qlen = Math.sqrt(
                                               a.rot_0 ** 2 +
                                               a.rot_1 ** 2 +
                                               a.rot_2 ** 2 +
                                               a.rot_3 ** 2,
                                       );
                                       rot[0] = (a.rot_0 / qlen) * 128 + 128;
                                       rot[1] = (a.rot_1 / qlen) * 128 + 128;
                                       rot[2] = (a.rot_2 / qlen) * 128 + 128;
                                       rot[3] = (a.rot_3 / qlen) * 128 + 128;
                                       scales[0] = Math.exp(a.scale_0);
                                       scales[1] = Math.exp(a.scale_1);
                                       scales[2] = Math.exp(a.scale_2);
                               } else {
                                       scales[0] = 0.01;
                                       scales[1] = 0.01;
                                       scales[2] = 0.01;
                                       rot[0] = 255;
                                       rot[1] = 0;
                                       rot[2] = 0;
                                       rot[3] = 0;
                               }

                               if ("f_dc_0" in a) {
                                       const SH_C0 = 0.28209479177387814;
                                       rgba[0] = (0.5 + SH_C0 * a.f_dc_0) * 255;
                                       rgba[1] = (0.5 + SH_C0 * a.f_dc_1) * 255;
                                       rgba[2] = (0.5 + SH_C0 * a.f_dc_2) * 255;
                               } else {
                                       rgba[0] = a.red || 0;
                                       rgba[1] = a.green || 0;
                                       rgba[2] = a.blue || 0;
                               }
                               rgba[3] = "opacity" in a ? (1 / (1 + Math.exp(-a.opacity))) * 255 : 255;
                       }
                       return buffer;
               }

               // Binary little-endian path
               let dataView = new DataView(
                       inputBuffer,
                       header_end_index + header_end.length,
               );
               let row = 0;
               const hasScale = Boolean(types["scale_0"]);
               const hasOpacity = Boolean(types["opacity"]);
               const hasFdc = Boolean(types["f_dc_0"]);
               const hasRgb = Boolean(types["red"]);
               const xMethod = types["x"];
               const yMethod = types["y"];
               const zMethod = types["z"];
               const scale0Method = types["scale_0"];
               const scale1Method = types["scale_1"];
               const scale2Method = types["scale_2"];
               const opacityMethod = types["opacity"];
               const rot0Method = types["rot_0"];
               const rot1Method = types["rot_1"];
               const rot2Method = types["rot_2"];
               const rot3Method = types["rot_3"];
               const fdc0Method = types["f_dc_0"];
               const fdc1Method = types["f_dc_1"];
               const fdc2Method = types["f_dc_2"];
               const redMethod = types["red"];
               const greenMethod = types["green"];
               const blueMethod = types["blue"];
               const getX = xMethod ? dataView[xMethod].bind(dataView) : null;
               const getY = yMethod ? dataView[yMethod].bind(dataView) : null;
               const getZ = zMethod ? dataView[zMethod].bind(dataView) : null;
               const getScale0 = scale0Method ? dataView[scale0Method].bind(dataView) : null;
               const getScale1 = scale1Method ? dataView[scale1Method].bind(dataView) : null;
               const getScale2 = scale2Method ? dataView[scale2Method].bind(dataView) : null;
               const getOpacity = opacityMethod ? dataView[opacityMethod].bind(dataView) : null;
               const getRot0 = rot0Method ? dataView[rot0Method].bind(dataView) : null;
               const getRot1 = rot1Method ? dataView[rot1Method].bind(dataView) : null;
               const getRot2 = rot2Method ? dataView[rot2Method].bind(dataView) : null;
               const getRot3 = rot3Method ? dataView[rot3Method].bind(dataView) : null;
               const getFdc0 = fdc0Method ? dataView[fdc0Method].bind(dataView) : null;
               const getFdc1 = fdc1Method ? dataView[fdc1Method].bind(dataView) : null;
               const getFdc2 = fdc2Method ? dataView[fdc2Method].bind(dataView) : null;
               const getRed = redMethod ? dataView[redMethod].bind(dataView) : null;
               const getGreen = greenMethod ? dataView[greenMethod].bind(dataView) : null;
               const getBlue = blueMethod ? dataView[blueMethod].bind(dataView) : null;
               const xOffset = offsets["x"] || 0;
               const yOffset = offsets["y"] || 0;
               const zOffset = offsets["z"] || 0;
               const scale0Offset = offsets["scale_0"] || 0;
               const scale1Offset = offsets["scale_1"] || 0;
               const scale2Offset = offsets["scale_2"] || 0;
               const opacityOffset = offsets["opacity"] || 0;
               const rot0Offset = offsets["rot_0"] || 0;
               const rot1Offset = offsets["rot_1"] || 0;
               const rot2Offset = offsets["rot_2"] || 0;
               const rot3Offset = offsets["rot_3"] || 0;
               const fdc0Offset = offsets["f_dc_0"] || 0;
               const fdc1Offset = offsets["f_dc_1"] || 0;
               const fdc2Offset = offsets["f_dc_2"] || 0;
               const redOffset = offsets["red"] || 0;
               const greenOffset = offsets["green"] || 0;
               const blueOffset = offsets["blue"] || 0;
               const SH_C0 = 0.28209479177387814;

               console.time("calculate importance");
               const IMPORTANCE_THRESHOLD = 0.0015;
               let sizeList = [];
               let sizeIndex = [];
               for (row = 0; row < vertexCount; row++) {
                       if (!hasScale) {
                               sizeIndex.push(row);
                               sizeList.push(0);
                               continue;
                       }

                       const rowByteOffset = row * row_offset;
                       const s0 = Math.exp(getScale0 ? getScale0(rowByteOffset + scale0Offset, true) : 0);
                       const s1 = Math.exp(getScale1 ? getScale1(rowByteOffset + scale1Offset, true) : 0);
                       const s2 = Math.exp(getScale2 ? getScale2(rowByteOffset + scale2Offset, true) : 0);

                       //const minScale = Math.min(s0, s1, s2);
                       //const maxScale = Math.max(s0, s1, s2);

                       const size = s0 * s1 * s2;

                       const rawOpacity = getOpacity ? getOpacity(rowByteOffset + opacityOffset, true) : 0;
                       const opacity = 1 / (1 + Math.exp(-rawOpacity));
                       const opacityCubed = opacity * opacity * opacity;
                       const importance = Math.sqrt(Math.sqrt(size * opacityCubed));
                       if (importance < IMPORTANCE_THRESHOLD) continue;

                       sizeIndex.push(row);
                       sizeList.push(importance);
               }
               sizeIndex = new Uint32Array(sizeIndex);
               sizeList = new Float32Array(sizeList);
               vertexCount = sizeIndex.length;

               sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);

               const buffer = new ArrayBuffer(rowLength * vertexCount);

               for (let j = 0; j < vertexCount; j++) {
                       row = sizeIndex[j];
                       const rowByteOffset = row * row_offset;

                       const position = new Float32Array(buffer, j * rowLength, 3);
                       const scales = new Float32Array(buffer, j * rowLength + 12, 3);
                       const rgba = new Uint8ClampedArray(buffer, j * rowLength + 24, 4);
                       const rot = new Uint8ClampedArray(buffer, j * rowLength + 28, 4);

                       if (hasScale) {
                               const r0 = getRot0 ? getRot0(rowByteOffset + rot0Offset, true) : 0;
                               const r1 = getRot1 ? getRot1(rowByteOffset + rot1Offset, true) : 0;
                               const r2 = getRot2 ? getRot2(rowByteOffset + rot2Offset, true) : 0;
                               const r3 = getRot3 ? getRot3(rowByteOffset + rot3Offset, true) : 0;
                               const qlen = Math.sqrt(r0 ** 2 + r1 ** 2 + r2 ** 2 + r3 ** 2) || 1;
                               const invQlen = 1 / qlen;

                               rot[0] = r0 * invQlen * 128 + 128;
                               rot[1] = r1 * invQlen * 128 + 128;
                               rot[2] = r2 * invQlen * 128 + 128;
                               rot[3] = r3 * invQlen * 128 + 128;

                               scales[0] = Math.exp(getScale0 ? getScale0(rowByteOffset + scale0Offset, true) : 0);
                               scales[1] = Math.exp(getScale1 ? getScale1(rowByteOffset + scale1Offset, true) : 0);
                               scales[2] = Math.exp(getScale2 ? getScale2(rowByteOffset + scale2Offset, true) : 0);
                       } else {
                               scales[0] = 0.01;
                               scales[1] = 0.01;
                               scales[2] = 0.01;

                               rot[0] = 255;
                               rot[1] = 0;
                               rot[2] = 0;
                               rot[3] = 0;
                       }

                       position[0] = getX ? getX(rowByteOffset + xOffset, true) : 0;
                       position[1] = getY ? getY(rowByteOffset + yOffset, true) : 0;
                       position[2] = getZ ? getZ(rowByteOffset + zOffset, true) : 0;

                       if (hasFdc) {
                               rgba[0] = (0.5 + SH_C0 * (getFdc0 ? getFdc0(rowByteOffset + fdc0Offset, true) : 0)) * 255;
                               rgba[1] = (0.5 + SH_C0 * (getFdc1 ? getFdc1(rowByteOffset + fdc1Offset, true) : 0)) * 255;
                               rgba[2] = (0.5 + SH_C0 * (getFdc2 ? getFdc2(rowByteOffset + fdc2Offset, true) : 0)) * 255;
                       } else if (hasRgb) {
                               rgba[0] = getRed ? getRed(rowByteOffset + redOffset, true) : 0;
                               rgba[1] = getGreen ? getGreen(rowByteOffset + greenOffset, true) : 0;
                               rgba[2] = getBlue ? getBlue(rowByteOffset + blueOffset, true) : 0;
                       } else {
                               rgba[0] = 0;
                               rgba[1] = 0;
                               rgba[2] = 0;
                       }
                       const rawOpacity = getOpacity ? getOpacity(rowByteOffset + opacityOffset, true) : 0;
                       rgba[3] = hasOpacity ? (1 / (1 + Math.exp(-rawOpacity))) * 255 : 255;
               }
               return buffer;
       }
});
