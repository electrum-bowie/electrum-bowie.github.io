document.addEventListener("DOMContentLoaded", function () {
    const fileButton = document.getElementById("fileButton");
    const fileInput = document.getElementById("fileInput");
    const backButton = document.getElementById("backButton");

    if (backButton) {
        backButton.addEventListener("click", () => {
            location.reload();
        });
    }

    fileButton.addEventListener("click", () => {
        fileInput.click();
    });

    async function handleFile(file) {
        if (!file) return;
        
        let blob = file;
        const nameLower = file.name.toLowerCase();
        if (nameLower.endsWith(".zip")) {
            try {
                if (typeof JSZip === 'undefined') {
                    console.error('JSZip library missing');
                    return;
                }
                const zip = await JSZip.loadAsync(file);
                const entries = Object.values(zip.files);
                const target = entries.find(e => /\.ply$/i.test(e.name) || /\.splat$/i.test(e.name));
                if (!target) {
                    console.error("No supported file found inside zip");
                    return;
                }
                const data = await target.async("arraybuffer");
                blob = new Blob([data]);
            } catch (err) {
                console.error("Failed to extract zip", err);
                return;
            }
        } else if (!(nameLower.endsWith(".ply") || nameLower.endsWith(".splat"))) {
            console.error("Unsupported file type");
            return;
        }

        if (window.loadedBlobURL) {
            try {
                URL.revokeObjectURL(window.loadedBlobURL);
            } catch (e) {
                console.warn('Failed to revoke old object URL', e);
            }
        }

        const url = URL.createObjectURL(blob);

        window.loadedBlob = blob;
        window.loadedBlobURL = url;

        const entity = document.createElement("a-entity");
        entity.setAttribute("gaussian_splatting", `src: ${url};`);
        entity.setAttribute("rotation", `0 0 0`);
        entity.setAttribute("position", `0 1.5 -2`);
        entity.setAttribute("two-hand-manipulation", "");
        document.querySelector("a-scene").appendChild(entity);
        entity.addEventListener('loaded', () => {
            window.gaussianComponent = entity.components['gaussian_splatting'];
            if (window.gaussianComponent && typeof window.gaussianComponent.updateQuality === 'function') {
                window.gaussianComponent.updateQuality();
            }
        });

        // Reattach slider listeners in case the element was recreated
        const slider = document.getElementById("slider");
        if (slider) {
            slider.removeEventListener('input', updateSliderValue);
            slider.removeEventListener('change', updateSliderValue);
            slider.addEventListener('input', updateSliderValue);
            slider.addEventListener('change', updateSliderValue);
            if (typeof updateSliderValue === 'function') {
                updateSliderValue();
            }
        }

        if (fileButton) fileButton.style.display = "none";
        if (backButton) backButton.style.display = "block";
    }

    fileInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        if (file) console.log('Loading...');
        handleFile(file);
    });
});
