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
        this.startQuaternion = new THREE.Quaternion();
        this.startOffset = new THREE.Vector3();
        this.startOffsetSingle = new THREE.Vector3();
        this.startUpDir = new THREE.Vector3();
        this.leftStartQuat = new THREE.Quaternion();
        this.rightStartQuat = new THREE.Quaternion();
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
        this._tmpVec5 = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpQuat2 = new THREE.Quaternion();
        this._upVec = new THREE.Vector3(0, 1, 0);

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

            leftObj.object3D.getWorldQuaternion(this.leftStartQuat);
            rightObj.object3D.getWorldQuaternion(this.rightStartQuat);
            const leftUp = this._tmpVec1.set(0, 1, 0).applyQuaternion(this.leftStartQuat).projectOnPlane(this.startVector).normalize();
            const rightUp = this._tmpVec2.set(0, 1, 0).applyQuaternion(this.rightStartQuat).projectOnPlane(this.startVector).normalize();
            this.startUpDir.copy(leftUp.add(rightUp));
            if (this.startUpDir.lengthSq() < 1e-8) this.startUpDir.set(0, 0, 1);
            this.startUpDir.normalize();
        }

        const scaleFactor = currentDistance / this.startDistance;
        const newScale = this._tmpVec3.copy(this.startScale).multiplyScalar(scaleFactor);
        this.el.object3D.scale.copy(newScale);

        const currentVector = this._tmpVec2.copy(rightPos).sub(leftPos).normalize();

        const startHoriz = this._tmpVec3.copy(this.startVector).projectOnPlane(this._upVec);
        if (startHoriz.lengthSq() < 1e-8) startHoriz.set(1, 0, 0);
        startHoriz.normalize();
        const currentHoriz = this._tmpVec4.copy(currentVector).projectOnPlane(this._upVec);
        if (currentHoriz.lengthSq() < 1e-8) currentHoriz.set(1, 0, 0);
        currentHoriz.normalize();
        const yawCross = this._tmpVec5.crossVectors(startHoriz, currentHoriz);
        let yawAngle = startHoriz.angleTo(currentHoriz);
        if (yawCross.dot(this._upVec) < 0) yawAngle = -yawAngle;

        leftObj.object3D.getWorldQuaternion(this._tmpQuat);
        rightObj.object3D.getWorldQuaternion(this._tmpQuat2);
        const leftUpCur = this._tmpVec1.set(0, 1, 0).applyQuaternion(this._tmpQuat).projectOnPlane(currentVector);
        const rightUpCur = this._tmpVec2.set(0, 1, 0).applyQuaternion(this._tmpQuat2).projectOnPlane(currentVector);
        const currentUpDir = this._tmpVec5.copy(leftUpCur).add(rightUpCur);
        if (currentUpDir.lengthSq() < 1e-8) currentUpDir.copy(this.startUpDir);
        currentUpDir.normalize();
        const pitchCross = this._tmpVec1.crossVectors(this.startUpDir, currentUpDir);
        let pitchAngle = this.startUpDir.angleTo(currentUpDir);
        if (pitchCross.dot(currentVector) < 0) pitchAngle = -pitchAngle;

        let axis;
        let angle;
        if (Math.abs(pitchAngle) >= Math.abs(yawAngle)) {
            axis = currentVector.clone();
            angle = pitchAngle;
        } else {
            axis = this._upVec.clone();
            angle = yawAngle;
        }

        const rotQuat = this._tmpQuat.setFromAxisAngle(axis.normalize(), angle);
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
