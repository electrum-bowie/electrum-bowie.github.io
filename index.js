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
                const pixelRatio = this.data.pixelRatio < 0 ? window.devicePixelRatio : this.data.pixelRatio;
                const xrPixelRatio = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
                this.el.sceneEl.renderer.setPixelRatio(pixelRatio);
                this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(xrPixelRatio);

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
                this.viewRotationMatrix = new THREE.Matrix3();

                this.splatsToDiscard = [];

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

				vec2 unpackInt16(uint value) {
					int v0 = int(value) >> 16;
					int v1 = int(value << 16) >> 16;
					return vec2(float(v1), float(v0));
				}

				void main() {
					ivec2 texPos = ivec2(int(splatIndex & 4095u), int(splatIndex >> 12));
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

                this.worker.onmessage = (e) => {
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
        loadData: function (src) {
                this.loadedVertexCount = 0;
                this.rowLength = 3 * 4 + 3 * 4 + 4 + 4;
                this.worker.postMessage({ method: "clear" });
                this.occlusionWorker.postMessage({ method: "clear" });
                this.originalBuffers = [];
                this.isCaching = true;
                const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

		fetch(src)
			.then(async (data) => {
				const reader = data.body.getReader();

				let bytesDownloaded = 0;
				let bytesProcesses = 0;
				let _totalDownloadBytes = data.headers.get("Content-Length");
				let totalDownloadBytes = _totalDownloadBytes ? parseInt(_totalDownloadBytes) : undefined;

				const chunks = [];
				const start = Date.now();
				let lastReportedProgress = 0;
				let isPly = true;

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
						chunks.push(value);
						if (!this.textureReady &&
							this.renderer.properties.get(this.centerAndScaleTexture) &&
							this.renderer.properties.get(this.covAndColorTexture)) {
							this.textureReady = true;
						}

						const bytesRemains = bytesDownloaded - bytesProcesses;
						if (!isPly && this.textureReady && bytesRemains > this.rowLength) {
							let vertexCount = Math.floor(bytesRemains / this.rowLength);
							const concatenatedChunksbuffer = new Uint8Array(bytesRemains);
							let offset = 0;
							for (const chunk of chunks) {
								concatenatedChunksbuffer.set(chunk, offset);
								offset += chunk.length;
							}
							chunks.length = 0;
							if (bytesRemains > vertexCount * this.rowLength) {
								const extra_data = new Uint8Array(bytesRemains - vertexCount * this.rowLength);
								extra_data.set(concatenatedChunksbuffer.subarray(bytesRemains - extra_data.length, bytesRemains), 0);
								chunks.push(extra_data);
							}
							const buffer = new Uint8Array(vertexCount * this.rowLength);
							buffer.set(concatenatedChunksbuffer.subarray(0, buffer.byteLength), 0);
							this.pushDataBuffer(buffer.buffer, vertexCount);
							bytesProcesses += vertexCount * this.rowLength;
						}
					} catch (error) {
						console.error(error);
						break;
					}
				}

				if (bytesDownloaded - bytesProcesses > 0) {
					// Concatenate the chunks into a single Uint8Array
					let concatenatedChunks = new Uint8Array(
						chunks.reduce((acc, chunk) => acc + chunk.length, 0)
					);
					let offset = 0;
					for (const chunk of chunks) {
						concatenatedChunks.set(chunk, offset);
						offset += chunk.length;
					}
					if (isPly) {
						concatenatedChunks = new Uint8Array(this.processPlyBuffer(concatenatedChunks.buffer));
					}
                                this.pushDataBuffer(concatenatedChunks.buffer, Math.floor(concatenatedChunks.byteLength / this.rowLength));
                                }
                        })
                        .finally(() => {
                                this.isCaching = false;
                                if (this.needsQualityUpdate) {
                                        this.needsQualityUpdate = false;
                                        this.updateQuality();
                                }
                                this.occludeSplatsNow();
                                this.filterSplatsNow();
                                this.sortSplatsNow();
                        });
        },
        pushDataBuffer: function (buffer, vertexCount) {
                if (this.loadedVertexCount + vertexCount > 4096 * 4096) {
                        vertexCount = 4096 * 4096 - this.loadedVertexCount;
                }
                if (vertexCount <= 0) {
                        return;
                }
                if (this.isCaching) {
                        this.originalBuffers.push(buffer.slice(0));
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
			let xoffset = (this.loadedVertexCount % 4096);
			let yoffset = Math.floor(this.loadedVertexCount / 4096);
			if (this.loadedVertexCount % 4096 != 0) {
				width = Math.min(4096, xoffset + vertexCount) - xoffset;
				height = 1;
			} else if (Math.floor(vertexCount / 4096) > 0) {
				width = 4096;
				height = Math.floor(vertexCount / 4096);
			} else {
				width = vertexCount % 4096;
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
        tick: function (time, timeDelta) {
                this.camera.getWorldPosition(this.tmpCameraPos);
                
                const camPosChanged = this.tmpCameraPos.distanceToSquared(this.lastCameraPos) > 0.001;

                this.camera.getWorldQuaternion(this.tmpCameraQuat);
                
                const camRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.tmpCameraQuat.dot(this.lastCameraQuat)))) > 0.003;
                const objPosChanged = this.object.position.distanceToSquared(this.lastObjectPos) > 0.001;
                const objRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.object.quaternion.dot(this.lastObjectQuat)))) > 0.003;
                const scaleChanged = this.object.scale.distanceToSquared(this.lastScale) > 0.001;

		if (this.lastExecTime === undefined) this.lastExecTime = time;
		const forceExec = (time - this.lastExecTime) >= 300; // 300ms

                if (camPosChanged || camRotChanged || objPosChanged || objRotChanged || scaleChanged || forceExec) {
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
                for (const buf of this.originalBuffers) {
                        this.pushDataBuffer(buf.slice(0), buf.byteLength / this.rowLength);
                }
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
                let normals = undefined;
                let fadeOpacities = undefined;

                const COUNT_SIZE = 2048 * 2048;

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

                        const fadeStep = 0.17;
                        const nearPlaneClip = -0.08;
                        for (let offset = 0, i = 0; i < vertexCount; offset += 16, i++) {
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
                                const edgeMultiplier = 1.0 + (edgeDist * 0.6);
                                
                                const pixelThreshold = (focal * radiusTransparencyProduct) / -depth;
                                const tooSmall = pixelThreshold < 0.7 * edgeMultiplier && !skipCullBehind;

                                let f = fadeOpacities[i];

				if (insideOfScreen) {
                                        const isOccluded = discardMark && discardMark[i] === 1;
					const was = wasOccluded[i] === 1;

					if (f === 2.0) f = (isOccluded || tooSmall) ? 0.0 : 1.0; // default unset value is 2.0

					if (tooSmall) f = Math.max(0, f - fadeStep);
					
					else if (isOccluded) f = Math.max(0, f - fadeStep * 1.9);

					else {
						const step = was ? fadeStep * 1.9 : fadeStep;
						f = Math.min(1, f + step);
					}

					if (isOccluded)
						wasOccluded[i] = 1;
					else if (was && f >= 1.0 - fadeStep)
						wasOccluded[i] = 0;
                                }
				else
				{
                                	f = 2.0;
                                        wasOccluded[i] = 0;
				}

				fadeOpacities[i] = f;

                                if (f < 0.15) continue;

                                depthList[validCount] = depth;
                                validIndexList[validCount] = i;
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

                const COUNT_SIZE = 2048 * 2048;

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

                        for (let offset = 0, i = 0; i < vertexCount; offset += 16, i++) {
                                const px = matrices[offset + 12];
                                const py = matrices[offset + 13];
                                const pz = matrices[offset + 14];

                                const clip_x = m0 * px + m4 * py + m8  * pz + m12;
                                const clip_y = m1 * px + m5 * py + m9  * pz + m13;
                                const clip_z = m2 * px + m6 * py + m10 * pz + m14;
                                const clip_w = m3 * px + m7 * py + m11 * pz + m15;

                                const depth = f0 * px + f1 * py + f2 * pz + f3;

                                depthList[validCount] = depth;
                                validIndexList[validCount] = i;
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
                                // if (maxRadius > 1.75) continue;

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

                                const radius = scaleFactor * maxRadius;
                                const opacity = matrices[offset + 11]; // 0-1 (0 transparent, 1 opaque)

                                const radiusTransparencyProduct = radius * opacity;
                                const skipCullBehind = (radiusTransparencyProduct / scaleFactor) > 0.3;

                                const edgeDist = Math.max(Math.abs(ndcX), Math.abs(ndcY));
                                const edgeMultiplier = 1.0 + (edgeDist * 0.6);

                                const pixelThreshold = (focal * radiusTransparencyProduct) / -depth;
                                const tooSmall = pixelThreshold < 0.7 * edgeMultiplier && !skipCullBehind;

                                if (tooSmall) continue;

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
                                        	const invLen = Math.sqrt(distSq);
                                        	const dot = nx * toCameraX * invLen + ny * toCameraY * invLen + nz * toCameraZ * invLen;
                                        	facingFactor = 1.0 - Math.max(0.0, dot);
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

                                const perceived = opacity * (avgResidual ** 0.75);
                                if (perceived < 0.00000000001) {
                                        discarded[discardCount++] = idx;
                                }

                                const attenuation = 1.0 - (opacity * facingFactor);
                                for (let y = y0; y <= y1; y++) {
                                        const row = y * GRID_SIZE;
                                        for (let x = x0; x <= x1; x++) {
                                                grid[row + x] *= attenuation;
                                        }
                                }
                        }

                        return discarded.subarray(0, discardCount);
                };

                self.onmessage = (e) => {
                        if (e.data.method == "clear") {
                                matrices = undefined;
                                normals = undefined;
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

               // Binary little-endian path (original implementation)
               let dataView = new DataView(
                       inputBuffer,
                       header_end_index + header_end.length,
               );
               let row = 0;
               const attrs = new Proxy(
                       {},
                       {
                               get(target, prop) {
                                       if (!types[prop]) throw new Error(prop + " not found");
                                       return dataView[types[prop]](
                                               row * row_offset + offsets[prop],
                                               true,
                                       );
                               },
                       },
               );

               console.time("calculate importance");
               const IMPORTANCE_THRESHOLD = 0.0015;
               let sizeList = [];
               let sizeIndex = [];
               for (row = 0; row < vertexCount; row++) {
                       if (!types["scale_0"]) {
                               sizeIndex.push(row);
                               sizeList.push(0);
                               continue;
                       }

                       const s0 = Math.exp(attrs.scale_0);
                       const s1 = Math.exp(attrs.scale_1);
                       const s2 = Math.exp(attrs.scale_2);

                       //const minScale = Math.min(s0, s1, s2);
                       //const maxScale = Math.max(s0, s1, s2);

                       const size = s0 * s1 * s2;

                       const opacity = 1 / (1 + Math.exp(-attrs.opacity));
                       const importance = Math.pow(size * opacity ** 3, 1/4);
                       if (importance < IMPORTANCE_THRESHOLD) continue;

                       sizeIndex.push(row);
                       sizeList.push(importance);
               }
               sizeIndex = new Uint32Array(sizeIndex);
               sizeList = new Float32Array(sizeList);
               vertexCount = sizeIndex.length;
               console.timeEnd("calculate importance");

               console.time("sort");
               sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
               console.timeEnd("sort");

               const buffer = new ArrayBuffer(rowLength * vertexCount);

               console.time("build buffer");
               for (let j = 0; j < vertexCount; j++) {
                       row = sizeIndex[j];

                       const position = new Float32Array(buffer, j * rowLength, 3);
                       const scales = new Float32Array(buffer, j * rowLength + 12, 3);
                       const rgba = new Uint8ClampedArray(buffer, j * rowLength + 24, 4);
                       const rot = new Uint8ClampedArray(buffer, j * rowLength + 28, 4);

                       if (types["scale_0"]) {
                               const qlen = Math.sqrt(
                                       attrs.rot_0 ** 2 +
                                       attrs.rot_1 ** 2 +
                                       attrs.rot_2 ** 2 +
                                       attrs.rot_3 ** 2,
                               );

                               rot[0] = (attrs.rot_0 / qlen) * 128 + 128;
                               rot[1] = (attrs.rot_1 / qlen) * 128 + 128;
                               rot[2] = (attrs.rot_2 / qlen) * 128 + 128;
                               rot[3] = (attrs.rot_3 / qlen) * 128 + 128;

                               scales[0] = Math.exp(attrs.scale_0);
                               scales[1] = Math.exp(attrs.scale_1);
                               scales[2] = Math.exp(attrs.scale_2);
                       } else {
                               scales[0] = 0.01;
                               scales[1] = 0.01;
                               scales[2] = 0.01;

                               rot[0] = 255;
                               rot[1] = 0;
                               rot[2] = 0;
                               rot[3] = 0;
                       }

                       position[0] = attrs.x;
                       position[1] = attrs.y;
                       position[2] = attrs.z;

                       if (types["f_dc_0"]) {
                               const SH_C0 = 0.28209479177387814;
                               rgba[0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
                               rgba[1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
                               rgba[2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
                       } else {
                               rgba[0] = attrs.red;
                               rgba[1] = attrs.green;
                               rgba[2] = attrs.blue;
                       }
                       if (types["opacity"]) {
                               rgba[3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;
                       } else {
                               rgba[3] = 255;
                       }
               }
               console.timeEnd("build buffer");
               return buffer;
       }
});