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
        this.overlay = null;
        this.colorTexture = null;
        this.overlayMesh = null;
        this.syntheticScene = new THREE.Scene();
        this.syntheticCamera = new THREE.Camera();

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
        // With no motion data, return last pose as approximation
        return lastPose;
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
            const geometry = new THREE.PlaneGeometry(2, 2);
            const material = new THREE.MeshBasicMaterial({ map: this.colorTexture });
            this.overlayMesh = new THREE.Mesh(geometry, material);
            this.syntheticScene.add(this.overlayMesh);
        } else {
            this.colorTexture.image.data.set(this.prevColor);
            this.colorTexture.needsUpdate = true;
        }
    },

    quatToYaw: function (q) {
        const ysqr = q.y * q.y;
        const t3 = 2.0 * (q.w * q.y + q.z * q.x);
        const t4 = 1.0 - 2.0 * (ysqr + q.z * q.z);
        return Math.atan2(t3, t4);
    },

    composeSyntheticFrame: function (pose) {
        if (!pose || !this.prevPose) return;
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!this.overlay) {
            this.overlay = document.createElement('canvas');
            this.overlay.style.position = 'absolute';
            this.overlay.style.left = '0';
            this.overlay.style.top = '0';
            this.overlay.style.pointerEvents = 'none';
            document.body.appendChild(this.overlay);
        }
        if (this.overlay.width !== size.x) this.overlay.width = size.x;
        if (this.overlay.height !== size.y) this.overlay.height = size.y;

        const ctx = this.overlay.getContext('2d');
        const imageData = new ImageData(new Uint8ClampedArray(this.prevColor.buffer), size.x, size.y);
        const temp = document.createElement('canvas');
        temp.width = size.x;
        temp.height = size.y;
        temp.getContext('2d').putImageData(imageData, 0, 0);

        const yawPrev = this.quatToYaw(this.prevPose.orientation);
        const yawCurr = this.quatToYaw(pose.orientation);
        const yawDiff = yawCurr - yawPrev;
        const pxShift = yawDiff * size.x * 0.5;

        ctx.setTransform(1, 0, 0, 1, pxShift, 0);
        ctx.clearRect(-pxShift, 0, size.x, size.y);
        ctx.drawImage(temp, 0, 0);

        if (this.overlayMesh) {
            this.overlayMesh.position.set(0, 0, -1);
            this.overlayMesh.rotation.set(0, yawDiff, 0);
            this.renderer.autoClear = true;
            this.renderer.render(this.syntheticScene, this.syntheticCamera);
        }
    }
});
