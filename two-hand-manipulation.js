AFRAME.registerComponent('two-hand-manipulation', {
    init: function () {
        const sceneEl = this.el.sceneEl;
        this.leftController = sceneEl.querySelector('[oculus-touch-controls*="hand: left"]');
        this.rightController = sceneEl.querySelector('[oculus-touch-controls*="hand: right"]');
        this.leftHand = sceneEl.querySelector('[hand-tracking-controls*="hand: left"]');
        this.rightHand = sceneEl.querySelector('[hand-tracking-controls*="hand: right"]');
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
        this.startYaw = 0;
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
        this._tmpVec1 = new THREE.Vector3();
        this._tmpVec2 = new THREE.Vector3();
        this._tmpVec3 = new THREE.Vector3();
        this._tmpVec4 = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpQuat2 = new THREE.Quaternion();
        this.rotationMode = null; // Tracks current rotation mode
        this._angleDiff = (a, b) => {
            let d = a - b;
            d = ((d + Math.PI) % (2 * Math.PI)) - Math.PI;
            return d;
        };

        const bindGripEvents = (controller, hand) => {
            if (!controller) return;
            const updatePinch = evt => {
                if (evt.detail && evt.detail.position) {
                    const pos = evt.detail.position;
                    if (hand === 'left') this.leftPinchPos.set(pos.x, pos.y, pos.z);
                    else this.rightPinchPos.set(pos.x, pos.y, pos.z);
                }
            };
            const updatePressedState = hand => {
                if (hand === 'left') this.leftGripPressed = this.leftGripButton || this.leftTriggerButton || this.leftUsingPinch;
                else this.rightGripPressed = this.rightGripButton || this.rightTriggerButton || this.rightUsingPinch;
            };
            const onDown = evt => {
                updatePinch(evt);
                const isPinch = evt.type.startsWith('pinch');
                const isGrip = evt.type.startsWith('grip') || evt.type.startsWith('squeeze');
                const isTrigger = evt.type.startsWith('trigger');
                if (hand === 'left') {
                    if (isGrip) this.leftGripButton = true;
                    if (isTrigger) this.leftTriggerButton = true;
                    this.leftUsingPinch = isPinch;
                    this.leftSource = controller;
                } else {
                    if (isGrip) this.rightGripButton = true;
                    if (isTrigger) this.rightTriggerButton = true;
                    this.rightUsingPinch = isPinch;
                    this.rightSource = controller;
                }
                updatePressedState(hand);
                this.tryStart();
            };
            const onUp = evt => {
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
        if (!leftObj || !rightObj) return;
        const leftPos = this.leftUsingPinch ? this.leftPinchPos.clone() : this._tmpVec1.copy(leftObj.object3D.getWorldPosition(this._tmpVec1));
        const rightPos = this.rightUsingPinch ? this.rightPinchPos.clone() : this._tmpVec2.copy(rightObj.object3D.getWorldPosition(this._tmpVec2));
        const midpoint = leftPos.clone().add(rightPos).multiplyScalar(0.5);
        this.startMidpoint.copy(midpoint);
        this.el.object3D.getWorldPosition(this.startPosition);
        this.startOffset.copy(this.startPosition).sub(midpoint);
        this.el.object3D.getWorldQuaternion(this.startQuaternion);
        this.twoHandStartTime = performance.now();
        this.delayScaleRotate = true;
        this.rotationMode = null; // reset rotation mode
        this.isInteracting = true;
        this.mode = 'two';
    },

    startSingleHand: function (hand) {
        const obj = hand === 'left' ? (this.leftSource || this.leftController || this.leftHand) : (this.rightSource || this.rightController || this.rightHand);
        if (!obj) return;
        const pos = hand === 'left'
            ? (this.leftUsingPinch ? this.leftPinchPos.clone() : this._tmpVec1.copy(obj.object3D.getWorldPosition(this._tmpVec1)))
            : (this.rightUsingPinch ? this.rightPinchPos.clone() : this._tmpVec1.copy(obj.object3D.getWorldPosition(this._tmpVec1)));
        this.el.object3D.getWorldPosition(this.startPosition);
        this.startOffsetSingle.copy(this.startPosition).sub(pos);
        this.singleHand = hand;
        this.mode = 'single';
        this.isInteracting = true;
    },

    tryStart: function () {
        if (this.leftGripPressed && this.rightGripPressed) {
            if (!this.isInteracting || this.mode !== 'two') this.startTwoHand();
        } else if (this.leftGripPressed || this.rightGripPressed) {
            const hand = this.leftGripPressed ? 'left' : 'right';
            if (!this.isInteracting || (this.mode === 'single' && this.singleHand !== hand)) this.startSingleHand(hand);
        }
    },

    tick: function () {
        if (!this.isInteracting) return;
        if (this.mode === 'single') {
            const obj = this.singleHand === 'left'
                ? (this.leftSource || this.leftController || this.leftHand)
                : (this.rightSource || this.rightController || this.rightHand);
            if (!obj) return;
            const pos = this.singleHand === 'left'
                ? (this.leftUsingPinch ? this.leftPinchPos.clone() : this._tmpVec1.copy(obj.object3D.getWorldPosition(this._tmpVec1)))
                : (this.rightUsingPinch ? this.rightPinchPos.clone() : this._tmpVec1.copy(obj.object3D.getWorldPosition(this._tmpVec1)));
            const newPos = pos.clone().add(this.startOffsetSingle);
            if (this.el.object3D.parent) this.el.object3D.parent.worldToLocal(newPos);
            this.el.object3D.position.copy(newPos);
            return;
        }

        const leftObj = this.leftSource || this.leftController || this.leftHand;
        const rightObj = this.rightSource || this.rightController || this.rightHand;
        if (!leftObj || !rightObj) return;
        const leftPos = this.leftUsingPinch ? this.leftPinchPos.clone() : this._tmpVec1.copy(leftObj.object3D.getWorldPosition(this._tmpVec1));
        const rightPos = this.rightUsingPinch ? this.rightPinchPos.clone() : this._tmpVec2.copy(rightObj.object3D.getWorldPosition(this._tmpVec2));
        const currentDistance = leftPos.distanceTo(rightPos);
        const midpoint = leftPos.clone().add(rightPos).multiplyScalar(0.5);
        const now = performance.now();

        if (this.delayScaleRotate) {
            if (now - this.twoHandStartTime < 100) {
                const newWorldPos = midpoint.clone().add(this.startOffset);
                if (this.el.object3D.parent) this.el.object3D.parent.worldToLocal(newWorldPos);
                this.el.object3D.position.copy(newWorldPos);
                return;
            }
            this.delayScaleRotate = false;
            this.startDistance = currentDistance;
            this.startScale.copy(this.el.object3D.scale);
            this.startVector.copy(rightPos).sub(leftPos).normalize();
            this.startYaw = Math.atan2(this.startVector.x, this.startVector.z);
        }

        const scaleFactor = currentDistance / this.startDistance;
        const newScale = this._tmpVec3.copy(this.startScale).multiplyScalar(scaleFactor);
        this.el.object3D.scale.copy(newScale);

        const currentVector = this._tmpVec3.copy(rightPos).sub(leftPos).normalize();
        const heightDiff = Math.abs(leftPos.y - rightPos.y);
        const heightThresh = currentDistance * 0.35;
        const newMode = heightDiff < heightThresh ? 'yaw' : 'axis';

        if (this.rotationMode !== newMode) {
            // Update reference orientation and offset to avoid snapping
            // Calculate the current scale factor so we can normalise the
            // offset before storing it. This prevents jumps when switching
            // between rotation modes.
            this.el.object3D.getWorldQuaternion(this.startQuaternion);
            this.el.object3D.getWorldPosition(this.startPosition);
            this.startOffset
                .copy(this.startPosition)
                .sub(midpoint)
                .divideScalar(scaleFactor);
            if (newMode === 'yaw') {
                this.startYaw = Math.atan2(currentVector.x, currentVector.z);
            } else {
                this.startVector.copy(currentVector);
            }
            this.rotationMode = newMode;
        }

        let rotQuat;
        if (this.rotationMode === 'yaw') {
            const currentYaw = Math.atan2(currentVector.x, currentVector.z);
            const yawDelta = this._angleDiff(currentYaw, this.startYaw);
            rotQuat = this._tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawDelta);
        } else {
            rotQuat = this._tmpQuat.setFromUnitVectors(this.startVector, currentVector);
        }
        const offset = this._tmpVec4.copy(this.startOffset).multiplyScalar(scaleFactor).applyQuaternion(rotQuat);
        const newWorldPos = midpoint.clone().add(offset);
        if (this.el.object3D.parent) this.el.object3D.parent.worldToLocal(newWorldPos);
        this.el.object3D.position.copy(newWorldPos);

        const worldQuat = this.startQuaternion.clone();
        worldQuat.premultiply(rotQuat);
        if (this.el.object3D.parent) {
            const parentQuat = this._tmpQuat2;
            this.el.object3D.parent.getWorldQuaternion(parentQuat);
            parentQuat.invert();
            worldQuat.premultiply(parentQuat);
        }
        this.el.object3D.quaternion.copy(worldQuat);
    }
});
