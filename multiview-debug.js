AFRAME.registerComponent('multiview-debug', {
  schema: {
    displayId: {type: 'string', default: 'logMultiview'}
  },

  init: function () {
    this.logElement = document.getElementById(this.data.displayId);
    if (!this.logElement) {
      console.warn('Multiview-debug component could not find display element with ID:', this.data.displayId);
      return;
    }

    this.onSessionStart = this.onSessionStart.bind(this);
    this.onSessionEnd = this.onSessionEnd.bind(this);

    // We can listen on the scene element for these events
    this.el.sceneEl.addEventListener('enter-vr', this.onSessionStart);
    this.el.sceneEl.addEventListener('exit-vr', this.onSessionEnd);
  },

  onSessionStart: function () {
    // A short delay to ensure the renderer is fully initialized in XR mode
    setTimeout(() => {
        const gl = this.el.sceneEl.renderer.getContext();
        const ext = gl.getExtension("OVR_multiview2") ||
                    gl.getExtension("OVR_multiview") ||
                    gl.getExtension("OCULUS_multiview") ||
                    gl.getExtension("WEBGL_multiview");

        // Check if the browser has the function that the gaussian_splatting component uses
        if (ext && this.el.sceneEl.renderer.xr.setMultiviewEnabled) {
          this.logElement.textContent = '✔️ - Multiview Supported';
          this.logElement.style.color = 'lime';
        } else {
          this.logElement.textContent = '❌ - Multiview Unsupported';
          this.logElement.style.color = 'red';
        }
    }, 500);
  },

  onSessionEnd: function () {
    this.logElement.textContent = 'multiview';
    this.logElement.style.color = '';
  },

  remove: function() {
    // Clean up listeners
    this.el.sceneEl.removeEventListener('enter-vr', this.onSessionStart);
    this.el.sceneEl.removeEventListener('exit-vr', this.onSessionEnd);
  }
}); 