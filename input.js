document.addEventListener("DOMContentLoaded", function () {
    const fileButton = document.getElementById("fileButton");
    const fileInput = document.getElementById("fileInput");
    const backButton = document.getElementById("backButton");

    let splatLoading = false;
    let splatLoaded = false;

    if (backButton) {
        backButton.addEventListener("click", () => {
            location.reload();
        });
    }

    fileButton.addEventListener("click", () => {
        if (splatLoading || splatLoaded) return;
        fileInput.click();
    });

    const SH_C0 = 0.28209479177387814;

    function convertSplatToPlyBuffer(arrayBuffer) {
        const recordBytes = 32; // bytes per splat record
        const vertexCount = arrayBuffer.byteLength / recordBytes;

        // Typed array views are faster than repeated DataView accesses.
        const floatView = new Float32Array(arrayBuffer, 0, vertexCount * 6);
        const byteView = new Uint8Array(arrayBuffer);

        const header = [
            'ply',
            'format binary_little_endian 1.0',
            `element vertex ${vertexCount}`,
            'property float x',
            'property float y',
            'property float z',
            'property float scale_0',
            'property float scale_1',
            'property float scale_2',
            'property float rot_0',
            'property float rot_1',
            'property float rot_2',
            'property float rot_3',
            'property float f_dc_0',
            'property float f_dc_1',
            'property float f_dc_2',
            'property float opacity',
            'end_header\n',
        ].join('\n');

        const headerBytes = new TextEncoder().encode(header);
        const plyRowBytes = 14 * 4; // float32 properties
        const outBuffer = new ArrayBuffer(headerBytes.length + vertexCount * plyRowBytes);
        const outUint8 = new Uint8Array(outBuffer);
        outUint8.set(headerBytes, 0);
        const outFloats = new Float32Array(outBuffer, headerBytes.length);

        const floatsPerRow = plyRowBytes / 4;
        for (let i = 0; i < vertexCount; i++) {
            const fBase = i * 6;
            const bBase = i * recordBytes;
            const x = floatView[fBase];
            const y = floatView[fBase + 1];
            const z = floatView[fBase + 2];
            const sx = floatView[fBase + 3];
            const sy = floatView[fBase + 4];
            const sz = floatView[fBase + 5];
            const r = byteView[bBase + 24];
            const g = byteView[bBase + 25];
            const b = byteView[bBase + 26];
            const a = byteView[bBase + 27];
            let q0 = (byteView[bBase + 28] - 128) / 128.0;
            let q1 = (byteView[bBase + 29] - 128) / 128.0;
            let q2 = (byteView[bBase + 30] - 128) / 128.0;
            let q3 = (byteView[bBase + 31] - 128) / 128.0;
            const qlen = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3) + 1e-8;
            q0 /= qlen; q1 /= qlen; q2 /= qlen; q3 /= qlen;
            const rgba = [r / 255, g / 255, b / 255, a / 255];
            const alpha = Math.min(Math.max(rgba[3], 1e-6), 1 - 1e-6);
            const opacity = -Math.log(1 / alpha - 1);
            const fdc0 = (rgba[0] - 0.5) / SH_C0;
            const fdc1 = (rgba[1] - 0.5) / SH_C0;
            const fdc2 = (rgba[2] - 0.5) / SH_C0;

            let off = i * floatsPerRow;
            outFloats[off++] = x;
            outFloats[off++] = y;
            outFloats[off++] = z;
            outFloats[off++] = Math.log(sx);
            outFloats[off++] = Math.log(sy);
            outFloats[off++] = Math.log(sz);
            outFloats[off++] = q0;
            outFloats[off++] = q1;
            outFloats[off++] = q2;
            outFloats[off++] = q3;
            outFloats[off++] = fdc0;
            outFloats[off++] = fdc1;
            outFloats[off++] = fdc2;
            outFloats[off++] = opacity;
        }

        return outBuffer;
    }

    async function handleFile(file) {
        if (!file) return;
        if (splatLoading || splatLoaded) return;
        splatLoading = true;

        let blob = file;
        const nameLower = file.name.toLowerCase();
        let targetName = file.name;
        if (nameLower.endsWith(".zip")) {
            try {
                if (typeof JSZip === 'undefined') {
                    console.error('JSZip library missing');
                    splatLoading = false;
                    return;
                }
                const zip = await JSZip.loadAsync(file);
                const entries = Object.values(zip.files);
                const target = entries.find(e => /\.ply$/i.test(e.name) || /\.splat$/i.test(e.name));
                if (!target) {
                    console.error("No supported file found inside zip");
                    splatLoading = false;
                    return;
                }
                targetName = target.name;
                const data = await target.async("arraybuffer");
                blob = new Blob([data]);
            } catch (err) {
                console.error("Failed to extract zip", err);
                splatLoading = false;
                return;
            }
        } else if (!(nameLower.endsWith(".ply") || nameLower.endsWith(".splat"))) {
            console.error("Unsupported file type");
            splatLoading = false;
            return;
        }

        if (targetName.toLowerCase().endsWith('.splat')) {
            try {
                const buf = await blob.arrayBuffer();
                const plyBuffer = convertSplatToPlyBuffer(buf);
                blob = new Blob([plyBuffer]);
            } catch (err) {
                console.error('Failed to convert .splat file', err);
                splatLoading = false;
                return;
            }
        }

        const url = URL.createObjectURL(blob);

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
            splatLoading = false;
            splatLoaded = true;
        });



        if (fileButton) fileButton.style.display = "none";
        if (backButton) backButton.style.display = "block";
    }

    fileInput.addEventListener("change", (event) => {
        if (splatLoading || splatLoaded) return;
        const file = event.target.files[0];
        if (file) console.log('Loading...');
        handleFile(file);
    });
});
