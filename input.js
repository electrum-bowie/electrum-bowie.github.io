document.addEventListener("DOMContentLoaded", function () {
    const fileButton = document.getElementById("fileButton");
    const fileInput = document.getElementById("fileInput");

    fileButton.addEventListener("click", () => {
        fileInput.click();
    });

    async function handleFile(file) {
        if (!file) return;
        
        console.log('Loading...');
        
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

        const url = URL.createObjectURL(blob);

        const entity = document.createElement("a-entity");
        entity.setAttribute("gaussian_splatting", `src: ${url};`);
        entity.setAttribute("rotation", `0 0 0`);
        entity.setAttribute("position", `0 1.5 -2`);
        entity.setAttribute("two-hand-manipulation", "");
        document.querySelector("a-scene").appendChild(entity);

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

        // Keep the file selection button visible even after a splat is loaded
        // so that users can load additional files without refreshing.
        // fileButton.style.display = "none";
    }

    fileInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        handleFile(file);
    });
});
