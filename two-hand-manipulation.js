AFRAME.registerComponent('two-hand-manipulation', {
    init: function () {
        const sceneEl = this.el.sceneEl;

        // Grab all controller and hand entities since there may be more than one
        const controllers = sceneEl.querySelectorAll('[oculus-touch-controls]');
        controllers.forEach(el => {
            const cfg = el.getAttribute('oculus-touch-controls');
            if (cfg && cfg.includes('hand: left')) this.leftController = el;
            if (cfg && cfg.includes('hand: right')) this.rightController = el;
        });

        const hands = sceneEl.querySelectorAll('[hand-controls], [hand-tracking-controls]');
        hands.forEach(el => {
            const hc = el.getAttribute('hand-controls') || el.getAttribute('hand-tracking-controls');
            if (hc && hc.includes('hand: left')) this.leftHand = el;
            if (hc && hc.includes('hand: right')) this.rightHand = el;
        });
        this.leftSource = null;
        this.rightSource = null;
        this.leftGripPressed = false;
        this.rightGripPressed = false;
        this.isInteracting = false;
        this.startDistance = 0;
        this.startScale = new THREE.Vector3();
        this.startMidpoint = new THREE.Vector3();
        this.startPosition = new THREE.Vector3();
        this.startVector = new THREE.Vector3();
        this.startQuaternion = new THREE.Quaternion();

        const bindGripEvents = (controller, hand) => {
            if (!controller) return;
            const onDown = (evt) => {
                console.log('onDown', hand, evt.type);
                if (hand === 'left') {
                    this.leftGripPressed = true;
                    this.leftSource = controller;
                } else {
                    this.rightGripPressed = true;
                    this.rightSource = controller;
                }
                this.tryStart();
            };
            const onUp = (evt) => {
                console.log('onUp', hand, evt.type);
                if (hand === 'left') {
                    this.leftGripPressed = false;
                } else {
                    this.rightGripPressed = false;
                }
                this.isInteracting = false;
            };
            ['gripdown', 'gripclose', 'squeezestart', 'pinchstarted'].forEach(evt =>
                controller.addEventListener(evt, onDown));
            ['gripup', 'gripopen', 'squeezeend', 'pinchended'].forEach(evt =>
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
            this.startVector.copy(rightPos).sub(leftPos).normalize();
            this.el.object3D.getWorldQuaternion(this.startQuaternion);
            this.isInteracting = true;
            console.log('interaction started');
        }
    },
    tick: function () {
        if (!this.isInteracting) return;
        console.log('tick');
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
        if (this.el.object3D.parent) {
            this.el.object3D.parent.worldToLocal(newPosition);
        }
        this.el.object3D.position.copy(newPosition);

        const currentVector = rightPos.clone().sub(leftPos).normalize();
        const rotQuat = new THREE.Quaternion().setFromUnitVectors(this.startVector, currentVector);
        const worldQuat = this.startQuaternion.clone();
        worldQuat.premultiply(rotQuat);
        if (this.el.object3D.parent) {
            const parentQuat = new THREE.Quaternion();
            this.el.object3D.parent.getWorldQuaternion(parentQuat);
            parentQuat.invert();
            worldQuat.premultiply(parentQuat);
        }
        this.el.object3D.quaternion.copy(worldQuat);
    }
});
