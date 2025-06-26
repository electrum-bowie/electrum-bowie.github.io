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
        this.leftGripButton = false;
        this.rightGripButton = false;
        this.leftTriggerButton = false;
        this.rightTriggerButton = false;
        this.isInteracting = false;
        this.startDistance = 0;
        this.startScale = new THREE.Vector3();
        this.startMidpoint = new THREE.Vector3();
        this.startPosition = new THREE.Vector3();
        this.startVector = new THREE.Vector3();
        this.startQuaternion = new THREE.Quaternion();
        this.startOffset = new THREE.Vector3();
        this.startOffsetSingle = new THREE.Vector3();
        this.singleHand = null;
        this.mode = null;
        this.leftPinchPos = new THREE.Vector3();
        this.rightPinchPos = new THREE.Vector3();
        this.leftUsingPinch = false;
        this.rightUsingPinch = false;
        this.twoHandStartTime = 0;
        this.delayScaleRotate = false;

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
            const updatePressedState = (hand) => {
                if (hand === 'left') {
                    this.leftGripPressed = this.leftGripButton || this.leftTriggerButton || this.leftUsingPinch;
                } else {
                    this.rightGripPressed = this.rightGripButton || this.rightTriggerButton || this.rightUsingPinch;
                }
            };
            const onDown = (evt) => {
                console.log('onDown', hand, evt.type);
                updatePinch(evt);
                const isPinch = evt.type.startsWith('pinch');
                const isGrip = evt.type.startsWith('grip') || evt.type.startsWith('squeeze');
                const isTrigger = evt.type.startsWith('trigger');
                if (hand === 'left') {
                    if (isGrip) this.leftGripButton = true;
                    if (isTrigger) this.leftTriggerButton = true;
                    this.leftUsingPinch = isPinch;
                    if (isPinch) this.leftSource = controller;
                    else if (isGrip || isTrigger) this.leftSource = controller;
                } else {
                    if (isGrip) this.rightGripButton = true;
                    if (isTrigger) this.rightTriggerButton = true;
                    this.rightUsingPinch = isPinch;
                    if (isPinch) this.rightSource = controller;
                    else if (isGrip || isTrigger) this.rightSource = controller;
                }
                updatePressedState(hand);
                this.tryStart();
            };
            const onUp = (evt) => {
                console.log('onUp', hand, evt.type);
                const isPinch = evt.type.startsWith('pinch');
                const isGrip = evt.type.startsWith('grip') || evt.type.startsWith('squeeze');
                const isTrigger = evt.type.startsWith('trigger');
                if (hand === 'left') {
                    if (isGrip) this.leftGripButton = false;
                    if (isTrigger) this.leftTriggerButton = false;
                    if (isPinch) this.leftUsingPinch = false;
                } else {
                    if (isGrip) this.rightGripButton = false;
                    if (isTrigger) this.rightTriggerButton = false;
                    if (isPinch) this.rightUsingPinch = false;
                }
                updatePressedState(hand);
                this.isInteracting = false;
                this.mode = null;
                this.tryStart();
            };
            ['pinchmoved'].forEach(evt => controller.addEventListener(evt, updatePinch));
            ['gripdown', 'gripclose', 'squeezestart', 'pinchstarted', 'triggerdown'].forEach(evt =>
                controller.addEventListener(evt, onDown));
            ['gripup', 'gripopen', 'squeezeend', 'pinchended', 'triggerup'].forEach(evt =>
                controller.addEventListener(evt, onUp));
        };

        bindGripEvents(this.leftController, 'left');
        bindGripEvents(this.rightController, 'right');
        bindGripEvents(this.leftHand, 'left');
        bindGripEvents(this.rightHand, 'right');
    },

    startTwoHand: function () {
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
        this.startOffset.copy(this.startPosition).sub(this.startMidpoint);
        this.startVector.copy(rightPos).sub(leftPos).normalize();
        this.el.object3D.getWorldQuaternion(this.startQuaternion);
        this.mode = 'two';
        this.isInteracting = true;
        this.twoHandStartTime = performance.now();
        this.delayScaleRotate = this.leftUsingPinch && this.rightUsingPinch;
    },
    startSingleHand: function (hand) {
        const obj = hand === 'left'
            ? (this.leftSource || this.leftController || this.leftHand)
            : (this.rightSource || this.rightController || this.rightHand);
        if (!obj) return;
        const pos = new THREE.Vector3();
        if (hand === 'left') {
            if (this.leftUsingPinch) {
                pos.copy(this.leftPinchPos);
            } else {
                obj.object3D.getWorldPosition(pos);
            }
        } else {
            if (this.rightUsingPinch) {
                pos.copy(this.rightPinchPos);
            } else {
                obj.object3D.getWorldPosition(pos);
            }
        }
        this.el.object3D.getWorldPosition(this.startPosition);
        this.startOffsetSingle.copy(this.startPosition).sub(pos);
        this.singleHand = hand;
        this.mode = 'single';
        this.isInteracting = true;
    },
    tryStart: function () {
        if (this.leftGripPressed && this.rightGripPressed) {
            if (!this.isInteracting || this.mode !== 'two') {
                this.isInteracting = false;
                this.startTwoHand();
            }
        } else if (this.leftGripPressed || this.rightGripPressed) {
            const hand = this.leftGripPressed ? 'left' : 'right';
            if (!this.isInteracting) {
                this.startSingleHand(hand);
            } else if (this.mode === 'single' && this.singleHand !== hand) {
                // switch controlling hand
                this.isInteracting = false;
                this.startSingleHand(hand);
            }
        }
    },
    tick: function () {
        if (!this.isInteracting) return;
        if (this.mode === 'single') {
            const obj = this.singleHand === 'left'
                ? (this.leftSource || this.leftController || this.leftHand)
                : (this.rightSource || this.rightController || this.rightHand);
            if (!obj) return;
            const pos = new THREE.Vector3();
            if (this.singleHand === 'left') {
                if (this.leftUsingPinch) {
                    pos.copy(this.leftPinchPos);
                } else {
                    obj.object3D.getWorldPosition(pos);
                }
            } else {
                if (this.rightUsingPinch) {
                    pos.copy(this.rightPinchPos);
                } else {
                    obj.object3D.getWorldPosition(pos);
                }
            }
            const newPos = pos.clone().add(this.startOffsetSingle);
            if (this.el.object3D.parent) {
                this.el.object3D.parent.worldToLocal(newPos);
            }
            this.el.object3D.position.copy(newPos);
            return;
        }

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

        const midpoint = leftPos.clone().add(rightPos).multiplyScalar(0.5);

        const now = performance.now();
        const delayActive = this.delayScaleRotate && (now - this.twoHandStartTime < 250);

        if (delayActive) {
            const offset = this.startOffset.clone();
            const newWorldPos = midpoint.clone().add(offset);
            if (this.el.object3D.parent) {
                this.el.object3D.parent.worldToLocal(newWorldPos);
            }
            this.el.object3D.position.copy(newWorldPos);
            return;
        }

        if (this.delayScaleRotate) {
            this.delayScaleRotate = false;
            this.startDistance = currentDistance;
            this.startScale.copy(this.el.object3D.scale);
            this.startMidpoint.copy(midpoint);
            this.el.object3D.getWorldPosition(this.startPosition);
            this.startOffset.copy(this.startPosition).sub(midpoint);
            this.startVector.copy(rightPos).sub(leftPos).normalize();
            this.el.object3D.getWorldQuaternion(this.startQuaternion);
        }

        const scaleFactor = currentDistance / this.startDistance;
        const newScale = this.startScale.clone().multiplyScalar(scaleFactor);

<<<<<<< 51776l-codex/new-task
=======
        const midpoint = leftPos.clone().add(rightPos).multiplyScalar(0.5);

        const now = performance.now();
        const delayActive = this.delayScaleRotate && (now - this.twoHandStartTime < 250);

        if (!delayActive) {
            if (this.delayScaleRotate) {
                this.delayScaleRotate = false;
                this.startDistance = currentDistance;
                this.startScale.copy(this.el.object3D.scale);
                this.startMidpoint.copy(midpoint);
                this.el.object3D.getWorldPosition(this.startPosition);
                this.startOffset.copy(this.startPosition).sub(midpoint);
                this.startVector.copy(rightPos).sub(leftPos).normalize();
                this.el.object3D.getWorldQuaternion(this.startQuaternion);
            }
            this.el.object3D.scale.copy(newScale);
        }

>>>>>>> alpha-hashing
        const currentVector = rightPos.clone().sub(leftPos).normalize();
        const rotQuat = new THREE.Quaternion().setFromUnitVectors(this.startVector, currentVector);

        let offset = this.startOffset.clone();
        let newWorldPos;
        if (!delayActive) {
            offset.multiplyScalar(scaleFactor).applyQuaternion(rotQuat);
            newWorldPos = midpoint.clone().add(offset);
        } else {
            newWorldPos = midpoint.clone().add(offset);
        }
        if (this.el.object3D.parent) {
            this.el.object3D.parent.worldToLocal(newWorldPos);
        }
        this.el.object3D.position.copy(newWorldPos);
        if (!delayActive) {
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
    }
});
