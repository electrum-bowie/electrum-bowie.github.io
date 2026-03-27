AFRAME.registerComponent('limit-framerate', {
    init: function () {
        const sceneEl = this.el.sceneEl || this.el;
        if (!sceneEl) return;

        sceneEl.addEventListener('enter-vr', () => {
            const xr = sceneEl.renderer && sceneEl.renderer.xr;
            const session = xr && xr.getSession ? xr.getSession() : null;
            if (!session || !session.updateTargetFrameRate || !session.supportedFrameRates) return;

            const rates = Array.from(session.supportedFrameRates || []).sort((a, b) => a - b);
            const target = rates[0];
            console.log("supportedFrameRates", rates, "target", target);
            if (typeof target !== 'number' || session.frameRate === target) return;

            session.updateTargetFrameRate(target).catch(err => {
                console.warn('Failed to updateTargetFrameRate', err);
            });
        });
    }
});
