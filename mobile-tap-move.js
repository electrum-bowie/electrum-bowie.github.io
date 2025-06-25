AFRAME.registerComponent('mobile-tap-move', {
    schema: {
        speed: { type: 'number', default: 1.0 },
        fadeDuration: { type: 'number', default: 700 } // ms to reach target speed
    },
    init: function () {
        this.moveDirection = 0; // 1 for forward, -1 for backward, 0 for none
        this.currentSpeed = 0;
        this.pointerIds = new Set();
        this.onTap = this.onTap.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);

        const addListeners = () => {
            const canvas = this.el.sceneEl.canvas;
            canvas.addEventListener('touchstart', this.onTap);
            canvas.addEventListener('pointerdown', this.onPointerDown);
            canvas.addEventListener('pointerup', this.onPointerUp);
            canvas.addEventListener('pointercancel', this.onPointerUp);
        };

        if (this.el.sceneEl.canvas) {
            addListeners();
        } else {
            this.el.sceneEl.addEventListener('render-target-loaded', addListeners, { once: true });
        }
    },
    remove: function () {
        if (this.el.sceneEl.canvas) {
            const canvas = this.el.sceneEl.canvas;
            canvas.removeEventListener('touchstart', this.onTap);
            canvas.removeEventListener('pointerdown', this.onPointerDown);
            canvas.removeEventListener('pointerup', this.onPointerUp);
            canvas.removeEventListener('pointercancel', this.onPointerUp);
        }
        this.moveDirection = 0;
        this.currentSpeed = 0;
        this.pointerIds.clear();
    },
    onTap: function (evt) {
        evt.preventDefault();
        const touches = evt.touches ? evt.touches.length : 1;
        if (touches === 1) {
            if (this.moveDirection === 0) {
                this.moveDirection = 1; // start forward
            } else {
                this.moveDirection = 0; // stop
            }
        } else if (touches >= 2) {
            if (this.moveDirection === 0) {
                this.moveDirection = -1; // start backward
            } else {
                this.moveDirection = 0; // stop
            }
        }
    },
    onPointerDown: function (evt) {
        if (evt.pointerType === 'touch') return;
        this.pointerIds.add(evt.pointerId);
        this.handlePointerGesture();
    },
    onPointerUp: function (evt) {
        if (evt.pointerType === 'touch') return;
        this.pointerIds.delete(evt.pointerId);
        this.handlePointerGesture();
    },
    handlePointerGesture: function () {
        const count = this.pointerIds.size;
        if (count === 1) {
            if (this.moveDirection === 0) {
                this.moveDirection = 1;
            } else {
                this.moveDirection = 0;
            }
        } else if (count >= 2) {
            if (this.moveDirection === 0) {
                this.moveDirection = -1;
            } else {
                this.moveDirection = 0;
            }
        }
    },
    tick: function (time, delta) {
        const camera = this.el.sceneEl.camera;
        if (!camera) return;

        const fadeDuration = this.data.fadeDuration;
        const deltaSec = delta / 1000;
        if (fadeDuration > 0) {
            const accel = this.data.speed / (fadeDuration / 1000);
            if (this.moveDirection !== 0) {
                this.currentSpeed = Math.min(this.currentSpeed + accel * deltaSec, this.data.speed);
            } else {
                this.currentSpeed = Math.max(this.currentSpeed - accel * deltaSec, 0);
            }
        } else {
            this.currentSpeed = this.moveDirection !== 0 ? this.data.speed : 0;
        }

        if (this.currentSpeed === 0 || this.moveDirection === 0) return;
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const d = this.currentSpeed * deltaSec * this.moveDirection;
        dir.multiplyScalar(d);
        camera.el.object3D.position.add(dir);
    }
});
