AFRAME.registerComponent('mobile-tap-move', {
    schema: {
        speed: { type: 'number', default: 1.0 },
        fadeDuration: { type: 'number', default: 400 } // ms to reach target speed
    },
    init: function () {
        this.moving = false;
        this.currentSpeed = 0;
        this.onTap = this.onTap.bind(this);

        if (AFRAME.utils.device.isMobile()) {
            // Wait for canvas to be ready
            if (this.el.sceneEl.canvas) {
                this.el.sceneEl.canvas.addEventListener('touchstart', this.onTap);
            } else {
                this.el.sceneEl.addEventListener('render-target-loaded', () => {
                    this.el.sceneEl.canvas.addEventListener('touchstart', this.onTap);
                }, { once: true });
            }
        }
    },
    remove: function () {
        if (this.el.sceneEl.canvas) {
            this.el.sceneEl.canvas.removeEventListener('touchstart', this.onTap);
        }
        this.moving = false;
        this.currentSpeed = 0;
    },
    onTap: function (evt) {
        evt.preventDefault();
        this.moving = !this.moving;
    },
    tick: function (time, delta) {
        const camera = this.el.sceneEl.camera;
        if (!camera) return;

        const fadeDuration = this.data.fadeDuration;
        const deltaSec = delta / 1000;
        if (fadeDuration > 0) {
            const accel = this.data.speed / (fadeDuration / 1000);
            if (this.moving) {
                this.currentSpeed = Math.min(this.currentSpeed + accel * deltaSec, this.data.speed);
            } else {
                this.currentSpeed = Math.max(this.currentSpeed - accel * deltaSec, 0);
            }
        } else {
            this.currentSpeed = this.moving ? this.data.speed : 0;
        }

        if (this.currentSpeed === 0) return;
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const d = this.currentSpeed * deltaSec;
        dir.multiplyScalar(d);
        camera.el.object3D.position.add(dir);
    }
});
