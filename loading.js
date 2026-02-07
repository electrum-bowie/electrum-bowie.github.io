(() => {
    const LOADING_THRESHOLD_MS = 1500;
    const CHECK_INTERVAL_MS = 200;

    const style = document.createElement('style');
    style.textContent = `
        #loadingIndicator {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: none;
            z-index: 2;
            pointer-events: none;
        }

        #loadingIndicator .spinner {
            width: 64px;
            height: 64px;
            border: 8px solid rgba(255, 255, 255, 0.3);
            border-top-color: #ffffff;
            border-radius: 50%;
            animation: loadingSpin 1s linear infinite;
        }

        @keyframes loadingSpin {
            from {
                transform: rotate(0deg);
            }
            to {
                transform: rotate(360deg);
            }
        }
    `;

    const indicator = document.createElement('div');
    indicator.id = 'loadingIndicator';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    indicator.appendChild(spinner);

    const ensureIndicator = () => {
        if (!document.body.contains(indicator)) {
            document.head.appendChild(style);
            document.body.appendChild(indicator);
        }
    };

    const updateVisibility = () => {
        const lastUpdate = window.lastWorkerUpdateTime;
        if (typeof lastUpdate !== 'number') {
            indicator.style.display = 'none';
            return;
        }
        const timeSinceUpdate = performance.now() - lastUpdate;
        indicator.style.display = timeSinceUpdate > LOADING_THRESHOLD_MS ? 'block' : 'none';
    };

    window.addEventListener('DOMContentLoaded', () => {
        ensureIndicator();
        updateVisibility();
        setInterval(() => {
            updateVisibility();
        }, CHECK_INTERVAL_MS);
    });
})();
