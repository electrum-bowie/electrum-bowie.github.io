AFRAME.registerComponent('two-hand-manipulation', {
    init: function () {
        const sceneEl = this.el.sceneEl;
        this.leftController = sceneEl.querySelector('[oculus-touch-controls*="hand: left"]');
        this.rightController = sceneEl.querySelector('[oculus-touch-controls*="hand: right"]');
        this.leftHand = sceneEl.querySelector('[hand-controls*="hand: left"], [hand-tracking-controls*="hand: left"]');
        this.rightHand = sceneEl.querySelector('[hand-controls*="hand: right"], [hand-tracking-controls*="hand: right"]');
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
        this.leftPinchPos = new THREE.Vector3();
        this.rightPinchPos = new THREE.Vector3();
        this.leftUsingPinch = false;
        this.rightUsingPinch = false;

        const bindGripEvents = (controller, hand) => {
            if (!controller) return;
            const updatePinch = (evt) => {
                if (evt.detail && evt.detail.position) {
                    const pos = evt.detail.position;
                    if (hand === 'left') {
                        this.leftPinchPos.set(pos.x, pos.y, pos.z);
                    } else {
                        this.rightPinchPos.set(pos.x, pos.y, pos.z);
                    }
                }
            };
            const onDown = (evt) => {
                console.log('onDown', hand, evt.type);
                updatePinch(evt);
                if (hand === 'left') {
                    this.leftGripPressed = true;
                    this.leftSource = controller;
                    this.leftUsingPinch = evt.type.startsWith('pinch');
                } else {
                    this.rightGripPressed = true;
                    this.rightSource = controller;
                    this.rightUsingPinch = evt.type.startsWith('pinch');
                }
                this.tryStart();
            };
            const onUp = (evt) => {
                console.log('onUp', hand, evt.type);
                if (hand === 'left') {
                    this.leftGripPressed = false;
                    this.leftUsingPinch = false;
                } else {
                    this.rightGripPressed = false;
                    this.rightUsingPinch = false;
                }
                this.isInteracting = false;
            };
            ['pinchmoved'].forEach(evt => controller.addEventListener(evt, updatePinch));
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
            if (this.leftUsingPinch) {
                leftPos.copy(this.leftPinchPos);
            } else {
                leftObj.object3D.getWorldPosition(leftPos);
            }
            if (this.rightUsingPinch) {
                rightPos.copy(this.rightPinchPos);
            } else {
                rightObj.object3D.getWorldPosition(rightPos);
            }

            this.startDistance = leftPos.distanceTo(rightPos);
            this.startScale.copy(this.el.object3D.scale);
            this.startMidpoint.copy(leftPos).add(rightPos).multiplyScalar(0.5);
            this.el.object3D.getWorldPosition(this.startPosition);
            this.startVector.copy(rightPos).sub(leftPos).normalize();
            this.el.object3D.getWorldQuaternion(this.startQuaternion);
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
        if (this.leftUsingPinch) {
            leftPos.copy(this.leftPinchPos);
        } else {
            leftObj.object3D.getWorldPosition(leftPos);
        }
        if (this.rightUsingPinch) {
            rightPos.copy(this.rightPinchPos);
        } else {
            rightObj.object3D.getWorldPosition(rightPos);
        }

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
