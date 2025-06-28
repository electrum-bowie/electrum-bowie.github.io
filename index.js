AFRAME.registerComponent("gaussian_splatting", {
        schema: {
                src: { type: 'string', default: "" },
                pixelRatio: { type: 'number', default: 0.5 },
                xrPixelRatio: { type: 'number', default: 0.7 },
                foveation: { type: 'number', default: 3.0 },
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
                        const ext = gl.getExtension("OVR_multiview2") ||
                                    gl.getExtension("OVR_multiview") ||
                                    gl.getExtension("OCULUS_multiview") ||
                                    gl.getExtension("WEBGL_multiview");
                        if (ext && this.el.sceneEl.renderer.xr.setMultiviewEnabled) {
                                this.el.sceneEl.renderer.xr.setMultiviewEnabled(true);
                                console.log("Multiview enabled");
                        } else {
                                console.log("Multiview not supported");
                        }
                        const session = this.el.sceneEl.renderer.xr.getSession?.();
                        const level = this.data.foveation;
                        if (session && session.renderState && session.renderState.baseLayer) {
                                const baseLayer = session.renderState.baseLayer;
                                if (baseLayer && 'fixedFoveation' in baseLayer) {
                                        baseLayer.fixedFoveation = level;
                                        console.log('Fixed foveated rendering set to', level);
                                } else if (this.el.sceneEl.renderer.xr.setFoveation) {
                                        this.el.sceneEl.renderer.xr.setFoveation(level);
                                        console.log('Fixed foveated rendering set to', level);
                                } else {
                                        console.log('Fixed foveated rendering not supported');
                                }
                        }
                });
        },
	// also works from vanilla three.js
	initGL: function (camera, object, renderer) {
		this.camera = camera;
		this.object = object;
		this.renderer = renderer;
		
		this.textureReady = false;
		this.object.frustumCulled = true;

		this.centerAndScaleData = new Float32Array(4096 * 4096 * 4);
		this.covAndColorData = new Uint32Array(4096 * 4096 * 4);
		this.centerAndScaleTexture = new THREE.DataTexture(this.centerAndScaleData, 4096, 4096, THREE.RGBA, THREE.FloatType);
		this.centerAndScaleTexture.needsUpdate = true;
		this.covAndColorTexture = new THREE.DataTexture(this.covAndColorData, 4096, 4096, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
		this.covAndColorTexture.internalFormat = "RGBA32UI";
		this.covAndColorTexture.needsUpdate = true;

                this.splatIndexArray = new Uint32Array(4096 * 4096);
                this.splatIndexes = new THREE.InstancedBufferAttribute(this.splatIndexArray, 1, false);
                this.splatIndexes.setUsage(THREE.DynamicDrawUsage);

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
                geometry.setAttribute('splatIndex', this.splatIndexes);
                geometry.instanceCount = 1;

                const size = renderer.getSize(new THREE.Vector2());
                this.wboitTargets = new THREE.WebGLMultipleRenderTargets(size.x, size.y, 2);
                this.wboitTargets.texture[0].format = THREE.RGBAFormat;
                this.wboitTargets.texture[0].type = THREE.HalfFloatType;
                this.wboitTargets.texture[1].format = THREE.RedFormat;
                this.wboitTargets.texture[1].type = THREE.HalfFloatType;
                this.wboitTargets.texture.forEach(t => {
                        t.minFilter = THREE.NearestFilter;
                        t.magFilter = THREE.NearestFilter;
                });

                this.resolveMaterial = new THREE.ShaderMaterial({
                        uniforms: {
                                accumColor: { value: this.wboitTargets.texture[0] },
                                accumWeight: { value: this.wboitTargets.texture[1] },
                                resolution: { value: new THREE.Vector2(size.x, size.y) }
                        },
                        vertexShader: `#version 300 es
                                in vec3 position;
                                out vec2 vUv;
                                void main(){
                                        vUv = position.xy * 0.5 + 0.5;
                                        gl_Position = vec4(position,1.0);
                                }`,
                        fragmentShader: `#version 300 es
                                precision highp float;
                                in vec2 vUv;
                                uniform sampler2D accumColor;
                                uniform sampler2D accumWeight;
                                uniform vec2 resolution;
                                out vec4 fragColor;
                                void main(){
                                        vec4 c = texture(accumColor, vUv);
                                        float w = texture(accumWeight, vUv).r;
                                        fragColor = vec4(c.rgb / max(w, 1e-4), 1.0);
                                }`,
                        depthTest: false,
                        depthWrite: false,
                        glslVersion: THREE.GLSL3
                });
                this.resolveScene = new THREE.Scene();
                const quadGeom = new THREE.PlaneGeometry(2,2);
                const quad = new THREE.Mesh(quadGeom, this.resolveMaterial);
                this.resolveScene.add(quad);
                this.resolveCamera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);

                const material = new THREE.ShaderMaterial({
                        uniforms: {
				viewport: { value: new Float32Array([1980, 1080]) }, // Dummy. will be overwritten
				focal: { value: 1000.0 }, // Dummy. will be overwritten
				centerAndScaleTexture: { value: this.centerAndScaleTexture },
				covAndColorTexture: { value: this.covAndColorTexture },
				gsProjectionMatrix: { value: this.getProjectionMatrix() },
				gsModelViewMatrix: { value: this.getModelViewMatrix() },
			},
                        vertexShader: `#version 300 es
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

				vec2 unpackInt16(in uint value) {
					int v = int(value);
					int v0 = v >> 16;
					int v1 = (v & 0xFFFF);
					if((v & 0x8000) != 0)
						v1 |= 0xFFFF0000;
					return vec2(float(v1), float(v0));
				}

				void main () {
					ivec2 texPos = ivec2(splatIndex%uint(4096),splatIndex/uint(4096));
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

					mat3 J = mat3(
						focal / camspace.z, 0., -(focal * camspace.x) / (camspace.z * camspace.z), 
						0., -focal / camspace.z, (focal * camspace.y) / (camspace.z * camspace.z), 
						0., 0., 0.
					);

					mat3 W = transpose(mat3(gsModelViewMatrix));
					mat3 T = W * J;
					mat3 cov = transpose(T) * Vrk * T;

					vec2 vCenter = vec2(pos2d) / pos2d.w;

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
					vColor = vec4(
						float(colorUint & uint(0xFF)) / 255.0,
						float((colorUint >> uint(8)) & uint(0xFF)) / 255.0,
						float((colorUint >> uint(16)) & uint(0xFF)) / 255.0,
						float(colorUint >> uint(24)) / 255.0
					);
					vPosition = position.xy;

					gl_Position = vec4(
						vCenter 
							+ position.x * v2 / viewport * 2.0 
							+ position.y * v1 / viewport * 2.0, pos2d.z / pos2d.w, 1.0);
				}
				`,
                        fragmentShader: `#version 300 es
                                precision highp float;
                                in vec4 vColor;
                                in vec2 vPosition;
                                layout(location = 0) out vec4 outColor;
                                layout(location = 1) out float outWeight;

                                void main () {
                                        float A = -dot(vPosition, vPosition);
                                        if (A < -3.45) discard;
                                        float B = exp(A) * vColor.a;
                                        outColor = vec4(vColor.rgb * B, B);
                                        outWeight = B;
                                }
                        `,
                        blending: THREE.CustomBlending,
                        blendSrc: THREE.OneFactor,
                        blendDst: THREE.OneFactor,
                        blendSrcAlpha: THREE.ZeroFactor,
                        blendDstAlpha: THREE.OneFactor,
                        depthTest: true,
                        depthWrite: false,
                        transparent: true,
                        glslVersion: THREE.GLSL3
                });
                material.dithering = false;

                material.onBeforeRender = ((renderer, scene, camera, geometry, object, group) => {
                        let projectionMatrix = this.getProjectionMatrix(camera);
                        this.mesh.material.uniforms.gsProjectionMatrix.value = projectionMatrix;
                        this.mesh.material.uniforms.gsModelViewMatrix.value = this.getModelViewMatrix(camera);

			let viewport = new THREE.Vector4();
			renderer.getCurrentViewport(viewport);
			
      const focal = (viewport.w / 2.0) * Math.abs(projectionMatrix.elements[5]);

			material.uniforms.viewport.value[0] = viewport.z;
			material.uniforms.viewport.value[1] = viewport.w;
			material.uniforms.focal.value = focal;
		});
		
                this.mesh = new THREE.Mesh(geometry, material);
                this.mesh.frustumCulled = true;
                this.object.add(this.mesh);
	},
        loadData: function (src) {
                this.loadedVertexCount = 0;
                this.rowLength = 3 * 4 + 3 * 4 + 4 + 4;
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
                                                        console.log("progress:", percent.toFixed(2) + "%", mbps.toFixed(2) + " Mbps");
								lastReportedProgress = percent;
							}
						} else {
                                                console.log("progress:", bytesDownloaded, ", unknown total");
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
                        });
        },
       pushDataBuffer: function (buffer, vertexCount) {
               if (this.loadedVertexCount + vertexCount > 4096 * 4096) {
                       vertexCount = 4096 * 4096 - this.loadedVertexCount;
               }
               if (vertexCount <= 0) {
                       return;
               }
                const startIndex = this.loadedVertexCount;
                if (this.isCaching) {
                        this.originalBuffers.push(buffer.slice(0));
                }
                const sliderElement = document.getElementById("slider");
                const sliderValueElement = document.getElementById("slider-value");
                const sliderLabelElement = document.getElementById("slider-label");
                let sliderValue = 1;
                if (sliderElement) {
                        const min = parseFloat(sliderElement.min);
                        const max = parseFloat(sliderElement.max);
                        
                        sliderValue = parseFloat(sliderElement.value);
                        
                        window.latestSliderValue = sliderValue;
                        
                        sliderValue = min + max - sliderValue;
                }
                else if (typeof window !== 'undefined' &&
                        typeof window.latestSliderValue === 'number') {
                        sliderValue = window.latestSliderValue;
                }

                vertexCount = vertexCount / (isNaN(sliderValue) ? 1 : sliderValue);

                // Keep the quality slider visible after loading so users can
                // continue adjusting the value for subsequent loads.
                if (sliderElement) {
                        // sliderElement.style.display = 'none';
                        if (sliderValueElement) {
                                // sliderValueElement.style.display = 'none';
                        }
                        if (sliderLabelElement) {
                                // sliderLabelElement.style.display = 'none';
                        }
                }

		let u_buffer = new Uint8Array(buffer);
		let f_buffer = new Float32Array(buffer);
		let matrices = new Float32Array(vertexCount * 16);

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
                        const maxScale = 9.0;
                        const minScale = 0.002;
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

			// Store scale and transparent to remove splat in sorting process
			mtx.elements[15] = Math.max(scale.x, scale.y, scale.z) * u_buffer[32 * i + 24 + 3] / 255.0;

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

                for (let i = 0; i < matrices.length / 16; i++) {
                        this.splatIndexArray[startIndex + i] = startIndex + i;
                }
                this.splatIndexes.needsUpdate = true;
                if (this.mesh && this.mesh.geometry) {
                        this.mesh.geometry.instanceCount = this.loadedVertexCount;
                        this.mesh.geometry.attributes.splatIndex.needsUpdate = true;
                }
	},
        tick: function () {
                if (!this.wboitTargets) return;
                const renderer = this.renderer;
                const size = renderer.getSize(new THREE.Vector2());
                if (this.wboitTargets.width !== size.x || this.wboitTargets.height !== size.y) {
                        this.wboitTargets.setSize(size.x, size.y);
                        this.resolveMaterial.uniforms.resolution.value.set(size.x, size.y);
                }
                renderer.setRenderTarget(this.wboitTargets);
                renderer.clear();
                this.mesh.visible = true;
                renderer.render(this.el.object3D, this.camera);
                this.mesh.visible = false;
                renderer.setRenderTarget(null);
                renderer.render(this.resolveScene, this.resolveCamera);
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
                this.centerAndScaleTexture.needsUpdate = true;
                this.covAndColorTexture.needsUpdate = true;
                for (const buf of this.originalBuffers) {
                        this.pushDataBuffer(buf.slice(0), buf.byteLength / this.rowLength);
                }
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
	processPlyBuffer: function (inputBuffer) {
		const ubuf = new Uint8Array(inputBuffer);
		// 10KB ought to be enough for a header...
		const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
		const header_end = "end_header\n";
		const header_end_index = header.indexOf(header_end);
		if (header_end_index < 0)
			throw new Error("Unable to read .ply file header");
		const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
		console.log("Vertex Count", vertexCount);
		let row_offset = 0,
			offsets = {},
			types = {};
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
			.split("\n")
			.filter((k) => k.startsWith("property "))) {
			const [p, type, name] = prop.split(" ");
			const arrayType = TYPE_MAP[type] || "getInt8";
			types[name] = arrayType;
			offsets[name] = row_offset;
			row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
		}

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
		let sizeList = new Float32Array(vertexCount);
		let sizeIndex = new Uint32Array(vertexCount);
		for (row = 0; row < vertexCount; row++) {
			sizeIndex[row] = row;
			if (!types["scale_0"]) continue;
			const size =
				Math.exp(attrs.scale_0) *
				Math.exp(attrs.scale_1) *
				Math.exp(attrs.scale_2);
			const opacity = 1 / (1 + Math.exp(-attrs.opacity));
			sizeList[row] = size * opacity;
		}
		console.timeEnd("calculate importance");

		console.time("sort");
		sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
		console.timeEnd("sort");

		// 6*4 + 4 + 4 = 8*4
		// XYZ - Position (Float32)
		// XYZ - Scale (Float32)
		// RGBA - colors (uint8)
		// IJKL - quaternion/rot (uint8)
		const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
		const buffer = new ArrayBuffer(rowLength * vertexCount);

		console.time("build buffer");
		for (let j = 0; j < vertexCount; j++) {
			row = sizeIndex[j];

			const position = new Float32Array(buffer, j * rowLength, 3);
			const scales = new Float32Array(buffer, j * rowLength + 4 * 3, 3);
			const rgba = new Uint8ClampedArray(
				buffer,
				j * rowLength + 4 * 3 + 4 * 3,
				4,
			);
			const rot = new Uint8ClampedArray(
				buffer,
				j * rowLength + 4 * 3 + 4 * 3 + 4,
				4,
			);

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
