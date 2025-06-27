AFRAME.registerComponent("gaussian_splatting", {
    schema: {
        src:          { type: "string",  default: ""   },
        pixelRatio:   { type: "number",  default: 0.5  },
        xrPixelRatio: { type: "number",  default: 0.9  },
        foveation:    { type: "number",  default: 3.0  }
    },

    /* ─────────────────────────────────── INIT ────────────────────────────────── */
    init() {
        /* renderer quality setup */
        const pr  = this.data.pixelRatio   < 0 ? window.devicePixelRatio : this.data.pixelRatio;
        const xpr = this.data.xrPixelRatio < 0 ? window.devicePixelRatio : this.data.xrPixelRatio;
        this.el.sceneEl.renderer.setPixelRatio(pr);
        this.el.sceneEl.renderer.xr.setFramebufferScaleFactor(xpr);

        /* bookkeeping */
        this.originalBuffers    = [];
        this.needsQualityUpdate = false;

        /* GL setup & data load */
        this.initGL(
            this.el.sceneEl.camera.el.components.camera.camera,
            this.el.object3D,
            this.el.sceneEl.renderer
        );
        this.loadData(this.data.src);

        /* XR session callback (multiview, foveation) */
        this.el.sceneEl.renderer.xr.addEventListener("sessionstart", async () => {
            const gl = this.el.sceneEl.renderer.getContext();
            if (gl.makeXRCompatible) {
                try { await gl.makeXRCompatible(); } catch (e) { console.warn("makeXRCompatible failed", e); }
            }

            const mvExt =
                   gl.getExtension("OVR_multiview2")
                || gl.getExtension("OVR_multiview")
                || gl.getExtension("OCULUS_multiview")
                || gl.getExtension("WEBGL_multiview");

            if (mvExt && this.el.sceneEl.renderer.xr.setMultiviewEnabled) {
                this.el.sceneEl.renderer.xr.setMultiviewEnabled(true);
                console.log("Multiview enabled");
            } else {
                console.log("Multiview not supported");
            }

            const session = this.el.sceneEl.renderer.xr.getSession?.();
            const level   = this.data.foveation;
            if (session && session.renderState?.baseLayer) {
                const bl = session.renderState.baseLayer;
                if (bl && "fixedFoveation" in bl) {
                    bl.fixedFoveation = level;
                } else if (this.el.sceneEl.renderer.xr.setFoveation) {
                    this.el.sceneEl.renderer.xr.setFoveation(level);
                } else {
                    console.log("Fixed foveated rendering not supported");
                }
            }
        });
    },

    /* ──────────────────────────────── GL + MATERIAL ─────────────────────────── */
    initGL(camera, object, renderer) {
        this.camera   = camera;
        this.object   = object;
        this.renderer = renderer;

        /* textures & buffers */
        this.centerAndScaleData = new Float32Array(4096 * 4096 * 4);
        this.covAndColorData    = new Uint32Array(4096 * 4096 * 4);

        this.centerAndScaleTexture = new THREE.DataTexture(
            this.centerAndScaleData, 4096, 4096, THREE.RGBA, THREE.FloatType
        );
        this.centerAndScaleTexture.needsUpdate = true;

        this.covAndColorTexture = new THREE.DataTexture(
            this.covAndColorData, 4096, 4096, THREE.RGBAIntegerFormat, THREE.UnsignedIntType
        );
        this.covAndColorTexture.internalFormat = "RGBA32UI";
        this.covAndColorTexture.needsUpdate    = true;

        /* instancing boiler-plate */
        const baseGeom      = new THREE.BufferGeometry();
        const quadPositions = new Float32Array(6 * 3);
        const posAttr       = new THREE.BufferAttribute(quadPositions, 3);
        baseGeom.setAttribute("position", posAttr);

        posAttr.setXYZ(2, -2,  2, 0);
        posAttr.setXYZ(1,  2,  2, 0);
        posAttr.setXYZ(0, -2, -2, 0);
        posAttr.setXYZ(5, -2, -2, 0);
        posAttr.setXYZ(4,  2,  2, 0);
        posAttr.setXYZ(3,  2, -2, 0);
        posAttr.needsUpdate = true;

        const instGeom = new THREE.InstancedBufferGeometry().copy(baseGeom);
        instGeom.setAttribute(
            "splatIndex",
            new THREE.InstancedBufferAttribute(new Uint32Array(4096 * 4096), 1, false)
        );
        instGeom.instanceCount = 1;

        /* ── SHADER MATERIAL ─────────────────────────────────────────────── */
        const material = new THREE.ShaderMaterial({
            uniforms: {
                viewport:            { value: new Float32Array([1980, 1080]) },
                focal:               { value: 1000.0 },
                centerAndScaleTexture: { value: this.centerAndScaleTexture },
                covAndColorTexture:    { value: this.covAndColorTexture },
                gsProjectionMatrix:    { value: this.getProjectionMatrix() },
                gsModelViewMatrix:     { value: this.getModelViewMatrix() }
            },

            vertexShader: `/* original long vertex shader unchanged */`,

            fragmentShader: `
                in vec4 vColor;
                in vec2 vPosition;

                void main() {
                    float A = -dot(vPosition, vPosition);
                    if (A < -4.0) discard;
                    float B = exp(A) * vColor.a;
                    gl_FragColor = vec4(vColor.rgb, B);
                }`,

            blending:      THREE.CustomBlending,
            blendSrcAlpha: THREE.OneFactor,
            depthTest:     true,
            depthWrite:    false,
            transparent:   true
        });

        /* ── FORCE 1×1 SHADING FOR THIS DRAW ─────────────────────────────── */
        const gl         = this.renderer.getContext();
        const shadingExt = gl.getExtension("QCOM_shading_rate");

        material.onBeforeRender = (renderer, scene, cam, geom, obj, grp) => {
            if (shadingExt) {
                shadingExt.shadingRateQCOM(shadingExt.SHADING_RATE_1X1_PIXELS_QCOM);
            }

            /* update dynamic uniforms */
            const proj = this.getProjectionMatrix(cam);
            material.uniforms.gsProjectionMatrix.value = proj;
            material.uniforms.gsModelViewMatrix.value  = this.getModelViewMatrix(cam);

            const vp = new THREE.Vector4();
            renderer.getCurrentViewport(vp);
            material.uniforms.viewport.value[0] = vp.z;
            material.uniforms.viewport.value[1] = vp.w;
            material.uniforms.focal.value       = (vp.w * 0.5) * Math.abs(proj.elements[5]);
        };

        if (shadingExt) {
            material.onAfterRender = () => {
                shadingExt.shadingRateQCOM(shadingExt.SHADING_RATE_2X2_PIXELS_QCOM);
            };
        } else {
            console.warn("QCOM_shading_rate not supported — pepper grid may persist");
        }

        /* mesh */
        const mesh = new THREE.Mesh(instGeom, material);
        mesh.frustumCulled = false;
        this.object.add(mesh);

        /* worker for sorting */
        this.worker = new Worker(
            URL.createObjectURL(
                new Blob(["(", this.createWorker.toString(), ")(self)"], { type: "application/javascript" })
            )
        );

        this.worker.onmessage = (e) => {
            const idx = new Uint32Array(e.data.sortedIndexes);
            mesh.geometry.attributes.splatIndex.set(idx);
            mesh.geometry.attributes.splatIndex.needsUpdate = true;
            mesh.geometry.instanceCount = idx.length;
            this.sortReady = true;
        };
        this.sortReady = true;
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

		this.worker.postMessage({
			method: "push",
			matrices: matrices.buffer
		}, [matrices.buffer]);
	},
        tick: function (time, timeDelta) {
                if (this.sortReady) {
                        this.sortReady = false;
                        let camera_mtx = this.getModelViewMatrix().elements;
                        let view = new Float32Array([camera_mtx[2], camera_mtx[6], camera_mtx[10], camera_mtx[14]]);
                        const globalScale = Math.max(this.object.scale.x, this.object.scale.y, this.object.scale.z);
                        this.worker.postMessage({
                                method: "sort",
                                view: view.buffer,
                                scale: globalScale,
                        }, [view.buffer]);
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
	createWorker: function (self) {
		let matrices = undefined;

                const sortSplats = function sortSplats(matrices, view, scaleFactor = 1.0) {
			const vertexCount = matrices.length / 16;
			let threshold = -0.001;

			let maxDepth = -Infinity;
			let minDepth = Infinity;
			let depthList = new Float32Array(vertexCount);
			let sizeList = new Int32Array(depthList.buffer);
			let validIndexList = new Int32Array(vertexCount);
			let validCount = 0;
			for (let i = 0; i < vertexCount; i++) {
				// Sign of depth is reversed
				let depth =
					(view[0] * matrices[i * 16 + 12]
						+ view[1] * matrices[i * 16 + 13]
						+ view[2] * matrices[i * 16 + 14]
						+ view[3]);

				// Skip behind of camera and small, transparent splat
                                if (depth < 0 && matrices[i * 16 + 15] * scaleFactor > threshold * depth) {
					depthList[validCount] = depth;
					validIndexList[validCount] = i;
					validCount++;
					if (depth > maxDepth) maxDepth = depth;
					if (depth < minDepth) minDepth = depth;
				};
			}

			// This is a 16 bit single-pass counting sort
			let depthInv = (256 * 256 - 1) / (maxDepth - minDepth);
			let counts0 = new Uint32Array(256 * 256);
			for (let i = 0; i < validCount; i++) {
				sizeList[i] = ((depthList[i] - minDepth) * depthInv) | 0;
				counts0[sizeList[i]]++;
			}
			let starts0 = new Uint32Array(256 * 256);
			for (let i = 1; i < 256 * 256; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
			let depthIndex = new Uint32Array(validCount);
			for (let i = 0; i < validCount; i++) depthIndex[starts0[sizeList[i]]++] = validIndexList[i];

			return depthIndex;
		};

		self.onmessage = (e) => {
			if (e.data.method == "clear") {
				matrices = undefined;
			}
			if (e.data.method == "push") {
				new_matrices = new Float32Array(e.data.matrices);
				if (matrices === undefined) {
					matrices = new_matrices;
				} else {
					resized = new Float32Array(matrices.length + new_matrices.length);
					resized.set(matrices);
					resized.set(new_matrices, matrices.length);
					matrices = resized;
				}
			}
                        if (e.data.method == "sort") {
                                if (matrices === undefined) {
                                        const sortedIndexes = new Uint32Array(1);
                                        self.postMessage({ sortedIndexes }, [sortedIndexes.buffer]);
                                } else {
                                        const view = new Float32Array(e.data.view);
                                        const scaleFactor = typeof e.data.scale === 'number' ? e.data.scale : 1.0;
                                        const sortedIndexes = sortSplats(matrices, view, scaleFactor);
                                        self.postMessage({ sortedIndexes }, [sortedIndexes.buffer]);
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
