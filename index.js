AFRAME.registerComponent("gaussian_splatting", {
        schema: {
                src: { type: 'string', default: "" },
                pixelRatio: { type: 'number', default: 0.8 },
                xrPixelRatio: { type: 'number', default: 0.8 },
                // Fixed foveation level. Set to 0 to disable foveated rendering
                foveation: { type: 'number', default: 1.0 },
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

                this.fadeOpacityData = new Float32Array(4096 * 4096);
                this.fadeOpacityTexture = new THREE.DataTexture(this.fadeOpacityData, 4096, 4096, THREE.RedFormat, THREE.FloatType);
                this.fadeOpacityTexture.generateMipmaps = false;
                this.fadeOpacityTexture.minFilter = THREE.NearestFilter;
                this.fadeOpacityTexture.magFilter = THREE.NearestFilter;
                this.fadeOpacityTexture.internalFormat = "R32F";
                this.fadeOpacityTexture.needsUpdate = true;

		let splatIndexArray = new Uint32Array(4096 * 4096);
		const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
		splatIndexes.setUsage(THREE.DynamicDrawUsage);

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
		geometry.instanceCount = 1;

                const material = new THREE.ShaderMaterial({
                        uniforms: {
                                viewport: { value: new Float32Array([1980, 1080]) }, // Dummy. will be overwritten
                                viewportInv: { value: new Float32Array([1.0, 1.0]) },
                                focal: { value: 1000.0 }, // Dummy. will be overwritten
                                centerAndScaleTexture: { value: this.centerAndScaleTexture },
                                covAndColorTexture: { value: this.covAndColorTexture },
                                fadeOpacityTexture: { value: this.fadeOpacityTexture },
                                gsProjectionMatrix: { value: this.getProjectionMatrix() },
                                gsModelViewMatrix: { value: this.getModelViewMatrix() },
                                viewRotationMatrix: { value: new THREE.Matrix3() },
                        },
			vertexShader: `
                                precision lowp usampler2D;

				out vec4 vColor;
				out vec2 vPosition;
				uniform vec2 viewportInv;
				uniform float focal;
				uniform mat4 gsProjectionMatrix;
				uniform mat4 gsModelViewMatrix;
				uniform mat3 viewRotationMatrix;

				attribute uint splatIndex;
                                uniform sampler2D centerAndScaleTexture;
                                uniform usampler2D covAndColorTexture;
                                uniform sampler2D fadeOpacityTexture;

				vec2 unpackInt16(uint value) {
					int v0 = int(value) >> 16;
					int v1 = int(value << 16) >> 16;
					return vec2(float(v1), float(v0));
				}

				void main() {
					ivec2 texPos = ivec2(int(splatIndex & 4095u), int(splatIndex >> 12));
					vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);
	
					vec4 camspace = gsModelViewMatrix * vec4(centerAndScaleData.xyz, 1);
					vec4 pos2d = gsProjectionMatrix * camspace;

                                        // float bounds = 2.0 * pos2d.w;

                                        // if (pos2d.z < -pos2d.w || pos2d.x < -bounds || pos2d.x > bounds || pos2d.y < -bounds || pos2d.y > bounds) {
                                                // gl_Position = vec4(0.0, 0.0, 99, 1.0); // push off-screen
                                                // return;
                                        // }
                                        
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
                                        float fade = texelFetch(fadeOpacityTexture, texPos, 0).r;
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

                                void main () {
                                        float len2 = dot(vPosition, vPosition);
                                        if (len2 > 4.1) discard;
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

		material.onBeforeRender = ((renderer, scene, camera, geometry, object, group) => {
			let projectionMatrix = this.getProjectionMatrix(camera);
			mesh.material.uniforms.gsProjectionMatrix.value = projectionMatrix;
                        const viewMatrix = this.getModelViewMatrix(camera);
                        mesh.material.uniforms.gsModelViewMatrix.value = viewMatrix;
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

		this.worker = new Worker(
			URL.createObjectURL(
				new Blob(["(", this.createWorker.toString(), ")(self)"], {
					type: "application/javascript",
				}),
			),
		);

                this.worker.onmessage = (e) => {
                        if (e.data.method === "sort") {
                                let indexes = new Uint32Array(e.data.sortedIndexes);
                                mesh.geometry.attributes.splatIndex.set(indexes);
                                mesh.geometry.attributes.splatIndex.needsUpdate = true;
                                mesh.geometry.instanceCount = indexes.length;
                                this.sortReady = true;
                        } else if (e.data.method === "filter") {
                                this.filterReady = true;
                        }
                        if (e.data.fadeOpacities) {
                                const fades = new Float32Array(e.data.fadeOpacities);
                                this.fadeOpacityData.set(fades);
                                this.fadeOpacityTexture.needsUpdate = true;
                        }
                };
                this.sortReady = true;
                this.filterReady = true;
	},
        loadData: function (src) {
                this.loadedVertexCount = 0;
                this.rowLength = 3 * 4 + 3 * 4 + 4 + 4;
                this.worker.postMessage({ method: "clear" });
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

                        this.fadeOpacityData[this.loadedVertexCount + i] = 1.0;

			// Store scale and transparent to remove splat in sorting process
			mtx.elements[15] = Math.max(scale.x, scale.y, scale.z);
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

                        const fadeOpacityTextureProperties = this.renderer.properties.get(this.fadeOpacityTexture);
                        gl.bindTexture(gl.TEXTURE_2D, fadeOpacityTextureProperties.__webglTexture);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, xoffset, yoffset, width, height, gl.RED, gl.FLOAT, this.fadeOpacityData, this.loadedVertexCount);

                        this.fadeOpacityTexture.needsUpdate = true;

			this.loadedVertexCount += width * height;
			vertexCount -= width * height;
		}

		this.worker.postMessage({
			method: "push",
			matrices: matrices.buffer
		}, [matrices.buffer]);
	},
        tick: function (time, timeDelta) {
                this.camera.getWorldPosition(this.tmpCameraPos);
                
                const camPosChanged = this.tmpCameraPos.distanceToSquared(this.lastCameraPos) > 0.001;

                this.camera.getWorldQuaternion(this.tmpCameraQuat);
                
                const camRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.tmpCameraQuat.dot(this.lastCameraQuat)))) > 0.008;
                const objPosChanged = this.object.position.distanceToSquared(this.lastObjectPos) > 1e-6;
                const objRotChanged = 2 * Math.acos(Math.min(1, Math.abs(this.object.quaternion.dot(this.lastObjectQuat)))) > 0.001;
                const scaleChanged = this.object.scale.distanceToSquared(this.lastScale) > 1e-6;

                if (camPosChanged || camRotChanged || objPosChanged || objRotChanged || scaleChanged) {
                        if (this.filterReady) this.filterSplatsNow();
                        if (this.sortReady) this.sortSplatsNow();
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
                this.fadeOpacityTexture.needsUpdate = true;
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
                this.worker.postMessage({
                        method: "filter",
                        view: view.buffer,
                        mvp: mvp.buffer,
                        scale: globalScale,
                        focal: focal,
                }, [view.buffer, mvp.buffer]);
        },

        sortSplatsNow: function () {
                if (!this.sortReady) return;
                this.sortReady = false;
                this.worker.postMessage({ method: "sort" });
                this.lastCameraMatrix.copy(this.camera.matrixWorld);
                this.lastObjectMatrix.copy(this.object.matrixWorld);
                this.lastScale.copy(this.object.scale);
                this.camera.getWorldPosition(this.lastCameraPos);
                this.camera.getWorldQuaternion(this.lastCameraQuat);
                this.lastObjectPos.copy(this.object.position);
                this.lastObjectQuat.copy(this.object.quaternion);
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
                let fadeOpacities = undefined;

                const COUNT_SIZE = 256 * 256;

                let cache = {
                        capacity: 0,
                        depthList: null,
                        sizeList: null,
                        validIndexList: null,
                        depthIndex: null,
                        tmpVisible: null,
                };

                const counts0 = new Uint32Array(COUNT_SIZE);
                const starts0 = new Uint32Array(COUNT_SIZE);
                let filterResult = { count: 0, minDepth: 0, maxDepth: 0 };

                const ensureCapacity = (n) => {
                        if (cache.capacity >= n) return;
                        cache.capacity = n;
                        cache.depthList = new Float32Array(n);
                        cache.sizeList = new Int32Array(cache.depthList.buffer);
                        cache.validIndexList = new Int32Array(n);
                        cache.depthIndex = new Uint32Array(n);
                        cache.tmpVisible = new Uint32Array(n);
                };

                const filterSplats = function filterSplats(matrices, view, mvp, scaleFactor = 1.0, focal = 1.0) {
                        const vertexCount = matrices.length / 16;
                        if (!fadeOpacities || fadeOpacities.length < vertexCount) {
                                const tmp = new Float32Array(vertexCount);
                                tmp.fill(2.0);
                                if (fadeOpacities) tmp.set(fadeOpacities.subarray(0, Math.min(fadeOpacities.length, vertexCount)));
                                fadeOpacities = tmp;
                        }

                        ensureCapacity(vertexCount);

                        let maxDepth = -Infinity;
                        let minDepth = Infinity;
                        let depthList = cache.depthList;
                        let validIndexList = cache.validIndexList;
                        let validCount = 0;

                        const v0 = view[0], v1 = view[1], v2 = view[2], v3 = view[3];
                        const m0 = mvp[0],  m1 = mvp[1],  m2 = mvp[2],  m3 = mvp[3];
                        const m4 = mvp[4],  m5 = mvp[5],  m6 = mvp[6],  m7 = mvp[7];
                        const m8 = mvp[8],  m9 = mvp[9],  m10 = mvp[10], m11 = mvp[11];
                        const m12 = mvp[12], m13 = mvp[13], m14 = mvp[14], m15 = mvp[15];

                        const fadeStep = 0.3;
                        for (let i = 0; i < vertexCount; i++) {
                                const base = i * 16;
                                const px = matrices[base + 12];
                                const py = matrices[base + 13];
                                const pz = matrices[base + 14];

                                const clip_x = m0 * px + m4 * py + m8  * pz + m12;
                                const clip_y = m1 * px + m5 * py + m9  * pz + m13;
                                const clip_z = m2 * px + m6 * py + m10 * pz + m14;
                                const clip_w = m3 * px + m7 * py + m11 * pz + m15;

                                const radius = matrices[i * 16 + 15] * scaleFactor;
                                const transparency = matrices[i * 16 + 11]; // 0-1
                                const radiusTransparencyProduct = radius * transparency;

                                const skipCull = (radiusTransparencyProduct / scaleFactor) > 0.2;

                                if (!skipCull && (clip_w <= 0.0 || clip_z <= -clip_w)) {
                                        continue;
                                }

                                const invW  = 1.0 / clip_w;

                                const ndcX  = clip_x * invW;
                                const ndcY  = clip_y * invW;
                                const ndcZ  = clip_z * invW;

                                if (!skipCull && (ndcZ < -1.0 || ndcZ > 1.0 || ndcX < -1.0 || ndcX > 1.0 || ndcY < -1.0 || ndcY > 1.0)) {
                                        continue; // centre is outside — skip splat
                                }

                                let depth = v0 * px + v1 * py + v2 * pz + v3;

                                const nearPlaneClip = -0.16;

                                if (!skipCull && (depth + radius > nearPlaneClip)) continue;

                                if (depth + radius > nearPlaneClip && !(ndcZ < -1.0 || ndcZ > 1.0 || ndcX < -1.0 || ndcX > 1.0 || ndcY < -1.0 || ndcY > 1.0)) {
                                        continue; // centre is inside the view and too close to the camera
                                }

                                const edgeDist = Math.max(Math.abs(ndcX), Math.abs(ndcY));
                                const edgeMultiplier = 1.0 + (edgeDist * 0.6);

                                const pixelThreshold = (focal * radiusTransparencyProduct) / -depth;
                                const tooSmall = (pixelThreshold < 1.0 * edgeMultiplier) && !skipCull;

                                let f = fadeOpacities[i];

                                if (tooSmall) {
                                        if (f === 2.0) f = 0.0; // default unset value is 2.0
                                        f = Math.max(0, f - fadeStep);
                                } else {
                                        if (f === 2.0) f = 1.0; // default unset value is 2.0
                                        f = Math.min(1, f + fadeStep);
                                }
                                fadeOpacities[i] = f;

                                if (tooSmall && f <= 0.05) continue;

                                depthList[validCount] = depth;
                                validIndexList[validCount] = i;
                                validCount++;
                                if (depth > maxDepth) maxDepth = depth;
                                if (depth < minDepth) minDepth = depth;
                        }

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
                        let depthIndex = cache.depthIndex;
                        for (let i = 0; i < validCount; i++) depthIndex[starts0[sizeList[i]]++] = validIndexList[i];

                        let tmpVisible = cache.tmpVisible;
                        let visibleCount = 0;

                        for (let j = validCount - 1; j >= 0; j--) {
                                const idx = depthIndex[j];
                                tmpVisible[visibleCount++] = idx;
                        }

                        let result = new Uint32Array(visibleCount);
                        for (let i = 0, j = visibleCount - 1; i < visibleCount; i++, j--) {
                                result[i] = tmpVisible[j];
                        }

                        return result;
                };

		self.onmessage = (e) => {
                        if (e.data.method == "clear") {
                                matrices = undefined;
                                fadeOpacities = undefined;
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
                                        const view = new Float32Array(e.data.view);
                                        const mvp = new Float32Array(e.data.mvp);
                                        const scaleFactor = typeof e.data.scale === 'number' ? e.data.scale : 1.0;
                                        const focal = typeof e.data.focal === 'number' ? e.data.focal : 1.0;
                                        filterSplats(matrices, view, mvp, scaleFactor, focal);
                                }
                                const fadeCopy = fadeOpacities ? new Float32Array(fadeOpacities) : new Float32Array(1).fill(2.0);
                                self.postMessage({ method: "filter", fadeOpacities: fadeCopy }, [fadeCopy.buffer]);
                        }
                        if (e.data.method == "sort") {
                                if (matrices === undefined) {
                                        const sortedIndexes = new Uint32Array(1);
                                        const fadeCopy = new Float32Array(1);
                                        fadeCopy[0] = 2.0;
                                        self.postMessage({ method: "sort", sortedIndexes, fadeOpacities: fadeCopy }, [sortedIndexes.buffer, fadeCopy.buffer]);
                                } else {
                                        const sortedIndexes = sortSplats();
                                        const fadeCopy = new Float32Array(fadeOpacities);
                                        self.postMessage({ method: "sort", sortedIndexes, fadeOpacities: fadeCopy }, [sortedIndexes.buffer, fadeCopy.buffer]);
                                }
                        }
                };
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