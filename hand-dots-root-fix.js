AFRAME.registerComponent('hand-dots-root-fix', {
    init: function () {
        this._fixed = false;
    },

    tick: function () {
        if (this._fixed) return;

        const hand = this.el.components['hand-tracking-controls'];
        if (!hand || hand.data.modelStyle !== 'dots') return;
        if (!hand.jointEls || hand.jointEls.length === 0) return;

        const sceneObj = this.el.sceneEl && this.el.sceneEl.object3D;
        if (!sceneObj) return;


        for (let i = 0; i < hand.jointEls.length; i++) {
            sceneObj.attach(hand.jointEls[i].object3D);
        }

        this._fixed = true;
    }
});
