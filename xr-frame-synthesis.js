// XR Frame Synthesis component
AFRAME.registerComponent('xr-frame-synthesis', {
    schema: {
        fakeFrames: { type: 'int', default: 1 }
    },

    init: function () {
        const scene = this.el.sceneEl;
        this.renderer = scene && scene.renderer;
        this.prevColor = null;
        this.prevDepth = null;
        this.prevPose = null;
        this.frameCount = 0;
        this.colorTexture = null;
        this.depthTexture = null;
        this.overlayMesh = null;
        this.warpMaterial = null;
        this.syntheticScene = new THREE.Scene();
        this.syntheticCamera = new THREE.Camera();
        this.prevInvViewProj = new THREE.Matrix4();

        if (!this.renderer) {
            console.warn('XR Frame Synthesis: renderer not ready');
        }
    },

    tick: function () {
        if (!this.renderer || !this.renderer.xr || !this.renderer.xr.isPresenting) {
            return;
        }

        const frame = this.renderer.xr.getFrame && this.renderer.xr.getFrame();
        if (!frame) return;

        const doRealRender = (this.frameCount % (this.data.fakeFrames + 1)) === 0;
        if (doRealRender) {
            this.captureCurrentFrame();
            this.prevPose = this.getViewerPose(frame);
        } else if (this.prevColor && this.prevDepth && this.prevPose) {
            const pose = this.predictPose(frame, this.prevPose);
            this.composeSyntheticFrame(pose);
        }
        this.frameCount++;
    },

    getViewerPose: function (frame) {
        const ref = this.renderer.xr.getReferenceSpace();
        const viewerPose = frame.getViewerPose(ref);
        if (!viewerPose || !viewerPose.views.length) return null;
        return {
            position: {
                x: viewerPose.views[0].transform.position.x,
                y: viewerPose.views[0].transform.position.y,
                z: viewerPose.views[0].transform.position.z
            },
            orientation: {
                x: viewerPose.views[0].transform.orientation.x,
                y: viewerPose.views[0].transform.orientation.y,
                z: viewerPose.views[0].transform.orientation.z,
                w: viewerPose.views[0].transform.orientation.w
            }
        };
    },

    predictPose: function (frame, lastPose) {
        const predicted = this.getViewerPose(frame);
        return predicted || lastPose;
    },

    captureCurrentFrame: function () {
        const gl = this.renderer.getContext();
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());

        if (!this.prevColor || this.prevColor.length !== size.x * size.y * 4) {
            this.prevColor = new Uint8Array(size.x * size.y * 4);
            this.prevDepth = new Float32Array(size.x * size.y);
        }

        gl.readPixels(0, 0, size.x, size.y, gl.RGBA, gl.UNSIGNED_BYTE, this.prevColor);
        if (gl.getParameter(gl.DEPTH_BITS) > 0) {
            gl.readPixels(0, 0, size.x, size.y, gl.DEPTH_COMPONENT, gl.FLOAT, this.prevDepth);
        }

        if (!this.colorTexture) {
            this.colorTexture = new THREE.DataTexture(this.prevColor, size.x, size.y, THREE.RGBAFormat);
            this.colorTexture.flipY = true;
            this.colorTexture.needsUpdate = true;
        } else {
            this.colorTexture.image.data.set(this.prevColor);
            this.colorTexture.needsUpdate = true;
        }

        if (!this.depthTexture) {
            this.depthTexture = new THREE.DataTexture(this.prevDepth, size.x, size.y, THREE.RedFormat, THREE.FloatType);
            this.depthTexture.flipY = true;
            this.depthTexture.needsUpdate = true;
        } else {
            this.depthTexture.image.data.set(this.prevDepth);
            this.depthTexture.needsUpdate = true;
        }

        if (!this.warpMaterial) {
            const geometry = new THREE.PlaneGeometry(2, 2);
            this.warpMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    colorTexture: { value: this.colorTexture },
                    depthTexture: { value: this.depthTexture },
                    warpMatrix: { value: new THREE.Matrix4() }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = vec4(position.xy, 0.0, 1.0);
                    }
                `,
                fragmentShader: `
                    precision highp float;
                    uniform sampler2D colorTexture;
                    uniform sampler2D depthTexture;
                    uniform mat4 warpMatrix;
                    varying vec2 vUv;
                    void main() {
                        float d = texture2D(depthTexture, vUv).r;
                        vec4 clipPrev = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
                        vec4 clipCurr = warpMatrix * clipPrev;
                        clipCurr /= clipCurr.w;
                        vec2 uv = clipCurr.xy * 0.5 + 0.5;
                        gl_FragColor = texture2D(colorTexture, uv);
                    }
                `,
                depthWrite: false,
                depthTest: false
            });
            this.overlayMesh = new THREE.Mesh(geometry, this.warpMaterial);
            this.syntheticScene.add(this.overlayMesh);
        }

        const camera = this.el.sceneEl.camera && this.el.sceneEl.camera.el.components.camera.camera;
        if (camera) {
            const prevProj = camera.projectionMatrix.clone();
            const prevView = camera.matrixWorldInverse.clone();
            const viewProj = new THREE.Matrix4().multiplyMatrices(prevProj, prevView);
            this.prevInvViewProj.copy(viewProj).invert();
        }
    },

    composeSyntheticFrame: function (pose) {
        if (!pose || !this.prevPose || !this.warpMaterial) return;

        const camera = this.el.sceneEl.camera && this.el.sceneEl.camera.el.components.camera.camera;
        if (!camera) return;

        const quat = new THREE.Quaternion(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
        const pos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
        const world = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
        const view = world.clone().invert();
        const proj = camera.projectionMatrix.clone();
        const warpMatrix = new THREE.Matrix4().multiplyMatrices(proj, view).multiply(this.prevInvViewProj);
        this.warpMaterial.uniforms.warpMatrix.value.copy(warpMatrix);
        this.warpMaterial.uniforms.colorTexture.value = this.colorTexture;
        this.warpMaterial.uniforms.depthTexture.value = this.depthTexture;

        this.renderer.autoClear = true;
        this.renderer.render(this.syntheticScene, this.syntheticCamera);
    }
});
