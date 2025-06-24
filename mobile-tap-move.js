AFRAME.registerComponent('mobile-tap-move', {
    schema: {
        speed: { type: 'number', default: 0.05 }
    },
    init: function () {
        this.moving = false;
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
    },
    onTap: function (evt) {
        evt.preventDefault();
        this.moving = !this.moving;
    },
    tick: function (time, delta) {
        if (!this.moving) return;
        const camera = this.el.sceneEl.camera;
        if (!camera) return;
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const d = this.data.speed * (delta / 1000);
        dir.multiplyScalar(d);
        camera.el.object3D.position.add(dir);
    }
});
