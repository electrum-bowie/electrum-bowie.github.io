AFRAME.registerComponent('two-hand-manipulation', {
    init: function () {
        const sceneEl = this.el.sceneEl;
        this.leftController = sceneEl.querySelector('[oculus-touch-controls][hand=left]');
        this.rightController = sceneEl.querySelector('[oculus-touch-controls][hand=right]');
        this.leftHand = sceneEl.querySelector('[hand-controls][hand=left]');
        this.rightHand = sceneEl.querySelector('[hand-controls][hand=right]');
        this.leftSource = null;
        this.rightSource = null;
        this.leftGripPressed = false;
        this.rightGripPressed = false;
        this.isInteracting = false;
        this.startDistance = 0;
        this.startScale = new THREE.Vector3();
        this.startMidpoint = new THREE.Vector3();
        this.startPosition = new THREE.Vector3();

        const bindGripEvents = (controller, hand) => {
            if (!controller) return;
            const onDown = () => {
                if (hand === 'left') {
                    this.leftGripPressed = true;
                    this.leftSource = controller;
                } else {
                    this.rightGripPressed = true;
                    this.rightSource = controller;
                }
                this.tryStart();
            };
            const onUp = () => {
                if (hand === 'left') {
                    this.leftGripPressed = false;
                } else {
                    this.rightGripPressed = false;
                }
                this.isInteracting = false;
            };
            ['gripdown', 'gripclose', 'squeezestart'].forEach(evt =>
                controller.addEventListener(evt, onDown));
            ['gripup', 'gripopen', 'squeezeend'].forEach(evt =>
                controller.addEventListener(evt, onUp));
        };

        bindGripEvents(this.leftController, 'left');
        bindGripEvents(this.rightController, 'right');
        bindGripEvents(this.leftHand, 'left');
        bindGripEvents(this.rightHand, 'right');
    },
    tryStart: function () {
        if (this.leftGripPressed && this.rightGripPressed && !this.isInteracting) {
            const leftObj = this.leftSource || this.leftController || this.leftHand;
            const rightObj = this.rightSource || this.rightController || this.rightHand;
            if (!leftObj || !rightObj) { return; }
            const leftPos = new THREE.Vector3();
            const rightPos = new THREE.Vector3();
            leftObj.object3D.getWorldPosition(leftPos);
            rightObj.object3D.getWorldPosition(rightPos);

            this.startDistance = leftPos.distanceTo(rightPos);
            this.startScale.copy(this.el.object3D.scale);
            this.startMidpoint.copy(leftPos).add(rightPos).multiplyScalar(0.5);
            this.el.object3D.getWorldPosition(this.startPosition);
            this.isInteracting = true;
        }
    },
    tick: function () {
        if (!this.isInteracting) return;
        const leftObj = this.leftSource || this.leftController || this.leftHand;
        const rightObj = this.rightSource || this.rightController || this.rightHand;
        if (!leftObj || !rightObj) { return; }
        const leftPos = new THREE.Vector3();
        const rightPos = new THREE.Vector3();
        leftObj.object3D.getWorldPosition(leftPos);
        rightObj.object3D.getWorldPosition(rightPos);

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
