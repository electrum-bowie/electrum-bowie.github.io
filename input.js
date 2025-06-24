document.addEventListener("DOMContentLoaded", function () {
    const fileButton = document.getElementById("fileButton");
    const fileInput = document.getElementById("fileInput");

    fileButton.addEventListener("click", () => {
        fileInput.click();
    });

    async function handleFile(file) {
        if (!file) return;

        let blob = file;
        if (file.name.toLowerCase().endsWith(".zip")) {
            try {
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
        }

        const url = URL.createObjectURL(blob);

        const entity = document.createElement("a-entity");
        entity.setAttribute("gaussian_splatting", `src: ${url};`);
        entity.setAttribute("rotation", `0 0 0`);
        entity.setAttribute("position", `0 1.5 -2`);
        document.querySelector("a-scene").appendChild(entity);

        fileButton.style.display = "none";
    }

    fileInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        handleFile(file);
    });
});
