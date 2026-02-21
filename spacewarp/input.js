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
        const floatView = new Float32Array(arrayBuffer);
        const byteView = new Uint8Array(arrayBuffer);
        const invSH_C0 = 1.0 / SH_C0;

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
        const outView = new DataView(outBuffer, headerBytes.length);

        for (let i = 0; i < vertexCount; i++) {
            const base = i * recordBytes;
            const floatIdx = (base >> 2); // divide by 4
            const x = floatView[floatIdx];
            const y = floatView[floatIdx + 1];
            const z = floatView[floatIdx + 2];
            const sx = floatView[floatIdx + 3];
            const sy = floatView[floatIdx + 4];
            const sz = floatView[floatIdx + 5];
            const r = byteView[base + 24];
            const g = byteView[base + 25];
            const b = byteView[base + 26];
            const a = byteView[base + 27];
            let q0 = (byteView[base + 28] - 128) / 128.0;
            let q1 = (byteView[base + 29] - 128) / 128.0;
            let q2 = (byteView[base + 30] - 128) / 128.0;
            let q3 = (byteView[base + 31] - 128) / 128.0;
            const qlen = Math.hypot(q0, q1, q2, q3) + 1e-8;
            q0 /= qlen; q1 /= qlen; q2 /= qlen; q3 /= qlen;
            const alpha = Math.min(Math.max(a / 255, 1e-6), 1 - 1e-6);
            const opacity = Math.log(alpha / (1 - alpha));
            const fdc0 = (r / 255 - 0.5) * invSH_C0;
            const fdc1 = (g / 255 - 0.5) * invSH_C0;
            const fdc2 = (b / 255 - 0.5) * invSH_C0;

            let off = i * plyRowBytes;
            outView.setFloat32(off, x, true); off += 4;
            outView.setFloat32(off, y, true); off += 4;
            outView.setFloat32(off, z, true); off += 4;
            outView.setFloat32(off, Math.log(sx), true); off += 4;
            outView.setFloat32(off, Math.log(sy), true); off += 4;
            outView.setFloat32(off, Math.log(sz), true); off += 4;
            outView.setFloat32(off, q0, true); off += 4;
            outView.setFloat32(off, q1, true); off += 4;
            outView.setFloat32(off, q2, true); off += 4;
            outView.setFloat32(off, q3, true); off += 4;
            outView.setFloat32(off, fdc0, true); off += 4;
            outView.setFloat32(off, fdc1, true); off += 4;
            outView.setFloat32(off, fdc2, true); off += 4;
            outView.setFloat32(off, opacity, true); off += 4;
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
