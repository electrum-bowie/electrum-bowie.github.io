AFRAME.registerComponent('two-hand-manipulation', {
    init: function () {
        const sceneEl = this.el.sceneEl;
        this.leftController = sceneEl.querySelector('[oculus-touch-controls][hand=left]');
        this.rightController = sceneEl.querySelector('[oculus-touch-controls][hand=right]');
        this.leftGripPressed = false;
        this.rightGripPressed = false;
        this.isInteracting = false;
        this.startDistance = 0;
        this.startScale = new THREE.Vector3();
        this.startMidpoint = new THREE.Vector3();
        this.startPosition = new THREE.Vector3();

        if (this.leftController) {
            this.leftController.addEventListener('gripdown', () => {
                this.leftGripPressed = true;
                this.tryStart();
            });
            this.leftController.addEventListener('gripup', () => {
                this.leftGripPressed = false;
                this.isInteracting = false;
            });
        }
        if (this.rightController) {
            this.rightController.addEventListener('gripdown', () => {
                this.rightGripPressed = true;
                this.tryStart();
            });
            this.rightController.addEventListener('gripup', () => {
                this.rightGripPressed = false;
                this.isInteracting = false;
            });
        }
    },
    tryStart: function () {
        if (this.leftGripPressed && this.rightGripPressed && !this.isInteracting) {
            const leftPos = new THREE.Vector3();
            const rightPos = new THREE.Vector3();
            this.leftController.object3D.getWorldPosition(leftPos);
            this.rightController.object3D.getWorldPosition(rightPos);

            this.startDistance = leftPos.distanceTo(rightPos);
            this.startScale.copy(this.el.object3D.scale);
            this.startMidpoint.copy(leftPos).add(rightPos).multiplyScalar(0.5);
            this.el.object3D.getWorldPosition(this.startPosition);
            this.isInteracting = true;
        }
    },
    tick: function () {
        if (!this.isInteracting) return;
        const leftPos = new THREE.Vector3();
        const rightPos = new THREE.Vector3();
        this.leftController.object3D.getWorldPosition(leftPos);
        this.rightController.object3D.getWorldPosition(rightPos);

        const currentDistance = leftPos.distanceTo(rightPos);
        if (this.startDistance === 0) return;

        const scaleFactor = currentDistance / this.startDistance;
        const newScale = this.startScale.clone().multiplyScalar(scaleFactor);
        this.el.object3D.scale.copy(newScale);

        const midpoint = leftPos.clone().add(rightPos).multiplyScalar(0.5);
        const deltaPos = midpoint.sub(this.startMidpoint);
        const newPosition = this.startPosition.clone().add(deltaPos);
        this.el.object3D.position.copy(newPosition);
    }
});
