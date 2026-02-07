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
            align-items: center;
            gap: 16px;
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

        #loadingIndicator .loadingText {
            color: #ffffff;
            font-family: "Helvetica Neue", Arial, sans-serif;
            font-size: 20px;
            font-weight: 500;
            letter-spacing: 0.02em;
            text-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
        }
    `;

    const indicator = document.createElement('div');
    indicator.id = 'loadingIndicator';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const loadingText = document.createElement('span');
    loadingText.className = 'loadingText';
    loadingText.textContent = 'Loading...';
    indicator.appendChild(spinner);
    indicator.appendChild(loadingText);

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
        indicator.style.display = timeSinceUpdate > LOADING_THRESHOLD_MS ? 'flex' : 'none';
    };

    window.addEventListener('DOMContentLoaded', () => {
        ensureIndicator();
        updateVisibility();
        setInterval(() => {
            updateVisibility();
        }, CHECK_INTERVAL_MS);
    });
})();
