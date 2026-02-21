AFRAME.registerComponent('limit-framerate', {
    init: function () {
        this.lastSession = null;
        this.pending = false;
    },

    isSpaceWarpActive: function () {
        const sceneEl = this.el;
        if (!sceneEl || !sceneEl.renderer) return false;
        const renderer = sceneEl.renderer;
        const xr = renderer.xr;
        return !!(renderer.spaceWarp === true && xr && xr.isPresenting && xr.isSpaceWarp === true && xr.spaceWarp);
    },

    tick: function () {
        if (!this.isSpaceWarpActive()) return;

        const sceneEl = this.el;
        const xr = sceneEl.renderer.xr;
        const session = xr && xr.getSession ? xr.getSession() : null;
        if (!session || !session.updateTargetFrameRate || !session.supportedFrameRates) return;

        if (this.lastSession === session) return;
        if (this.pending) return;

        this.pending = true;

        const rates = Array.from(session.supportedFrameRates || []).sort((a, b) => a - b);
        if (rates.length === 0) {
            this.lastSession = session;
            this.pending = false;
            return;
        }

        const target = rates[0];

        if (session.frameRate === target) {
            this.lastSession = session;
            this.pending = false;
            return;
        }

        session.updateTargetFrameRate(target).then(() => {
            console.log('[limit-framerate] target frame rate set to', target, 'current:', session.frameRate);
            this.lastSession = session;
            this.pending = false;
        }).catch((err) => {
            console.warn('[limit-framerate] failed to set target frame rate:', err);
            this.lastSession = session;
            this.pending = false;
        });
    }
});
