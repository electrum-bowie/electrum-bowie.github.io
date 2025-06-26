AFRAME.registerComponent('simple-fly', {
    schema: {
        speed: { type: 'number', default: 0.1 }
    },
    init: function () {
        this.rightController = this.el; // controller this component is attached to
        this.isFlying = false;

        if (this.rightController) {
            this.rightController.addEventListener('triggerdown', () => {
                this.startFlying();
                console.log('Flying started');
            });
            this.rightController.addEventListener('triggerup', () => {
                this.stopFlying();
                console.log('Flying stopped');
            });
        } else {
            console.warn('simple-fly component has no controller to bind to.');
        }
    },
    tick: function () {
        
        if (!this.gaussianSplattingEntity) {

            this.gaussianSplattingEntity = document.querySelector('[gaussian_splatting]');

        }
        if (this.gaussianSplattingEntity) {
            if (this.isFlying) {
                this.fly();
            }
        }

    },
    startFlying: function () {
        this.isFlying = true;
        console.log('Start flying...');
    },
    stopFlying: function () {
        this.isFlying = false;
        console.log('Stop flying.');
    },
    fly: function () {
        if (this.rightController && this.gaussianSplattingEntity) {
            const direction = new THREE.Vector3();
            this.rightController.object3D.getWorldDirection(direction);
            direction.multiplyScalar(this.data.speed); // Invert the direction for the opposite translation
            this.gaussianSplattingEntity.object3D.position.add(direction.clone().negate());
            console.log('Flying in the opposite direction.');
        } else {
            console.warn('Right controller or Gaussian Splatting entity not found.');
        }
    }
});
