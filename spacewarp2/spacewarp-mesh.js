AFRAME.registerComponent('spacewarp-mesh', {
    schema: {
        meshName: { type: 'string', default: '' },
        meshNames: { type: 'string', default: '' }
    },

    init: function () {
        this.sceneEl = this.el.sceneEl;
        this.motionMeshes = [];
        this.sourceMeshes = [];
        this.spaceWarp = null;

        this.onModelLoaded = this.setup.bind(this);
        this.onObject3DSet = (event) => {
            if (!event.detail || event.detail.type === 'mesh') this.setup();
        };

        this.el.addEventListener('model-loaded', this.onModelLoaded);
        this.el.addEventListener('object3dset', this.onObject3DSet);

        if (this.el.getObject3D('mesh')) this.setup();
    },

    isSpaceWarpActive: function () {
        const sceneEl = this.sceneEl;
        if (!sceneEl || !sceneEl.renderer) return false;
        const renderer = sceneEl.renderer;
        const xr = renderer.xr;
        return !!(renderer.spaceWarp === true && xr && xr.isPresenting && xr.isSpaceWarp === true && xr.spaceWarp);
    },

    getMeshNameFilters: function () {
        const filters = [];
        const namesValue = (this.data.meshNames || '').trim();
        const singleValue = (this.data.meshName || '').trim();

        if (namesValue) {
            const tokens = namesValue.split(',');
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i].trim().toLowerCase();
                if (token && !filters.includes(token)) {
                    filters.push(token);
                }
            }
        }

        if (singleValue) {
            const token = singleValue.toLowerCase();
            if (!filters.includes(token)) {
                filters.push(token);
            }
        }

        return filters;
    },

    isSelectAllFilter: function (meshFilters) {
        for (let i = 0; i < meshFilters.length; i++) {
            const filter = meshFilters[i];
            if (filter === 'all' || filter === '*') return true;
        }

        return false;
    },

    collectCandidateMeshes: function (root) {
        if (!root) return [];

        const meshes = [];

        root.traverse((node) => {
            if (
                node.isMesh &&
                !node.isSkinnedMesh &&
                node.geometry &&
                node.geometry.attributes &&
                node.geometry.attributes.position
            ) {
                meshes.push(node);
            }
        });

        return meshes;
    },

    getHandDotsMeshes: function () {
        const hand = this.el && this.el.components ? this.el.components['hand-tracking-controls'] : null;
        if (!hand || !hand.data || hand.data.modelStyle !== 'dots') return [];

        const jointEls = hand.jointEls;
        if (!jointEls || jointEls.length === 0) return [];

        const meshes = [];
        for (let i = 0; i < jointEls.length; i++) {
            const jointEl = jointEls[i];
            const jointRoot = jointEl && jointEl.object3D ? jointEl.object3D : null;
            if (!jointRoot) continue;

            const jointMeshes = this.collectCandidateMeshes(jointRoot);
            for (let j = 0; j < jointMeshes.length; j++) {
                const mesh = jointMeshes[j];
                if (!meshes.includes(mesh)) meshes.push(mesh);
            }
        }

        return meshes;
    },

    selectSourceMeshes: function (root) {
        const handDotsMeshes = this.getHandDotsMeshes();
        const meshes = handDotsMeshes.length > 0 ? handDotsMeshes : this.collectCandidateMeshes(root);

        if (meshes.length === 0) return [];

        const pickLargest = (list) => {
            let best = list[0];
            let bestCount = best.geometry.attributes.position.count;

            for (let i = 1; i < list.length; i++) {
                const candidate = list[i];
                const candidateCount = candidate.geometry.attributes.position.count;
                if (candidateCount > bestCount) {
                    best = candidate;
                    bestCount = candidateCount;
                }
            }

            return best;
        };

        const meshFilters = this.getMeshNameFilters();

        if (this.isSelectAllFilter(meshFilters)) {
            return meshes;
        }

        if (meshFilters.length > 0) {
            const named = [];
            for (let i = 0; i < meshFilters.length; i++) {
                const filter = meshFilters[i];
                for (let j = 0; j < meshes.length; j++) {
                    const mesh = meshes[j];
                    const name = (mesh.name || '').toLowerCase();
                    if (!name) continue;
                    if (name === filter || name.includes(filter)) {
                        if (!named.includes(mesh)) named.push(mesh);
                    }
                }
            }

            if (named.length > 0) return named;
        }

        return [pickLargest(meshes)];
    },

    hasSameSourceMeshes: function (nextSourceMeshes) {
        if (this.sourceMeshes.length !== nextSourceMeshes.length) return false;
        for (let i = 0; i < nextSourceMeshes.length; i++) {
            if (this.sourceMeshes[i] !== nextSourceMeshes[i]) return false;
        }
        return true;
    },

    destroyMotionMeshes: function () {
        if (this.spaceWarp && this.spaceWarp.scene) {
            for (let i = 0; i < this.motionMeshes.length; i++) {
                const motionMesh = this.motionMeshes[i];
                this.spaceWarp.scene.remove(motionMesh);

                if (Array.isArray(motionMesh.material)) {
                    for (let j = 0; j < motionMesh.material.length; j++) {
                        motionMesh.material[j].dispose();
                    }
                } else if (motionMesh.material) {
                    motionMesh.material.dispose();
                }
            }
        }

        this.motionMeshes.length = 0;
        this.sourceMeshes.length = 0;
    },

    syncMotionMeshFromSource: function (motionMesh) {
        const xrFrameTransforms = motionMesh && motionMesh.userData ? motionMesh.userData.xrFrameTransforms : null;
        if (!xrFrameTransforms || !xrFrameTransforms.sourceMesh) return;
        motionMesh.matrixWorld.copy(xrFrameTransforms.sourceMesh.matrixWorld);
    },

    syncMotionFromSource: function () {
        if (this.motionMeshes.length === 0) return;

        const hand = this.el && this.el.components ? this.el.components['hand-tracking-controls'] : null;
        const isDotsHand = !!(hand && hand.data && hand.data.modelStyle === 'dots' && hand.jointEls && hand.jointEls.length > 0);
        const updateRoot = (isDotsHand && this.sceneEl && this.sceneEl.object3D) ? this.sceneEl.object3D : this.el.object3D;

        if (updateRoot.updateWorldMatrix) {
            updateRoot.updateWorldMatrix(true, true);
        } else {
            updateRoot.updateMatrixWorld(true);
        }

        for (let i = 0; i < this.motionMeshes.length; i++) {
            this.syncMotionMeshFromSource(this.motionMeshes[i]);
        }
    },

    createMotionMesh: function (sourceMesh, index) {
        const sourceMaterial = Array.isArray(sourceMesh.material) ? sourceMesh.material[0] : sourceMesh.material;
        const material = this.createMaterial();
        const motionMesh = new THREE.Mesh(sourceMesh.geometry, material);

        motionMesh.matrixAutoUpdate = false;
        motionMesh.frustumCulled = false;
        motionMesh.renderOrder = 9999 + index;
        motionMesh.material.side = sourceMaterial && sourceMaterial.side !== undefined ? sourceMaterial.side : THREE.FrontSide;

        motionMesh.userData.xrFrameTransforms = {
            sourceMesh: sourceMesh,
            prevModelMatrix: new THREE.Matrix4(),
            prevViewLeft: new THREE.Matrix4(),
            prevProjLeft: new THREE.Matrix4(),
            prevViewRight: new THREE.Matrix4(),
            prevProjRight: new THREE.Matrix4(),
            hasPreviousFrame: false
        };

        motionMesh.onAfterRender = (renderer, scene, camera) => {
            const camL = camera.cameras && camera.cameras[0];
            const camR = camera.cameras && camera.cameras[1];
            if (!camL || !camR) return;

            const xrFrameTransforms = motionMesh.userData.xrFrameTransforms;
            if (!xrFrameTransforms) return;

            xrFrameTransforms.prevModelMatrix.copy(motionMesh.matrixWorld);
            xrFrameTransforms.prevViewLeft.copy(camL.matrixWorldInverse);
            xrFrameTransforms.prevProjLeft.copy(camL.projectionMatrix);
            xrFrameTransforms.prevViewRight.copy(camR.matrixWorldInverse);
            xrFrameTransforms.prevProjRight.copy(camR.projectionMatrix);

            xrFrameTransforms.hasPreviousFrame = true;
        };

        return motionMesh;
    },

    setup: function () {
        if (!this.isSpaceWarpActive()) return;

        const renderer = this.sceneEl.renderer;
        this.spaceWarp = renderer.xr.spaceWarp;
        if (!this.spaceWarp || !this.spaceWarp.scene) return;

        const root = this.el.getObject3D('mesh') || this.el.object3D;

        const nextSourceMeshes = this.selectSourceMeshes(root);
        if (nextSourceMeshes.length === 0) return;

        if (this.motionMeshes.length > 0 && this.hasSameSourceMeshes(nextSourceMeshes)) return;

        if (this.motionMeshes.length > 0) this.destroyMotionMeshes();

        this.sourceMeshes = nextSourceMeshes;

        for (let i = 0; i < this.sourceMeshes.length; i++) {
            const sourceMesh = this.sourceMeshes[i];
            const motionMesh = this.createMotionMesh(sourceMesh, i);
            this.motionMeshes.push(motionMesh);
            this.spaceWarp.scene.add(motionMesh);
        }

        this.syncMotionFromSource();
    },

    tick: function () {
        if (!this.isSpaceWarpActive()) {
            if (this.motionMeshes.length > 0) this.destroyMotionMeshes();
            return;
        }

        if (this.motionMeshes.length === 0 || this.sourceMeshes.length === 0) {
            this.setup();
        }
    },

    tock: function () {
        if (!this.isSpaceWarpActive()) return;
        this.syncMotionFromSource();
    },

    remove: function () {
        this.el.removeEventListener('model-loaded', this.onModelLoaded);
        this.el.removeEventListener('object3dset', this.onObject3DSet);
        this.destroyMotionMeshes();
    },

    createMaterial: function () {
        const material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: {
                uProjLeft: { value: new THREE.Matrix4() },
                uViewModLeft: { value: new THREE.Matrix4() },
                uProjRight: { value: new THREE.Matrix4() },
                uViewModRight: { value: new THREE.Matrix4() },
                uPrevProjLeft: { value: new THREE.Matrix4() },
                uPrevViewModLeft: { value: new THREE.Matrix4() },
                uPrevProjRight: { value: new THREE.Matrix4() },
                uPrevViewModRight: { value: new THREE.Matrix4() }
            },
            vertexShader: `
                uniform mat4 uProjLeft;
                uniform mat4 uViewModLeft;
                uniform mat4 uPrevProjLeft;
                uniform mat4 uPrevViewModLeft;

                uniform mat4 uProjRight;
                uniform mat4 uViewModRight;
                uniform mat4 uPrevProjRight;
                uniform mat4 uPrevViewModRight;

                out vec4 curPos;
                out vec4 prevPos;

                void main() {
                    vec4 local = vec4(position, 1.0);

                    if (gl_ViewID_OVR == 0u) {
                        curPos = uProjLeft * uViewModLeft * local;
                        prevPos = uPrevProjLeft * uPrevViewModLeft * local;
                    } else {
                        curPos = uProjRight * uViewModRight * local;
                        prevPos = uPrevProjRight * uPrevViewModRight * local;
                    }

                    gl_Position = curPos;
                }
            `,
            fragmentShader: `
                precision highp float;

                in vec4 curPos;
                in vec4 prevPos;
                out highp vec4 outColor;

                void main() {
                    vec3 c = curPos.xyz / curPos.w;
                    vec3 p = prevPos.xyz / prevPos.w;
                    outColor = vec4(c - p, 0.0);
                }
            `,
            blending: THREE.NoBlending,
            side: THREE.FrontSide,
            depthWrite: true,
            depthTest: true
        });

        material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
            this.syncMotionMeshFromSource(object);

            const camL = camera.cameras && camera.cameras[0];
            const camR = camera.cameras && camera.cameras[1];
            if (!camL || !camR) return;

            const xrFrameTransforms = object && object.userData ? object.userData.xrFrameTransforms : null;
            if (!xrFrameTransforms) return;

            const prevModelMatrix = xrFrameTransforms.prevModelMatrix;
            const prevViewLeft = xrFrameTransforms.prevViewLeft;
            const prevProjLeft = xrFrameTransforms.prevProjLeft;
            const prevViewRight = xrFrameTransforms.prevViewRight;
            const prevProjRight = xrFrameTransforms.prevProjRight;

            if (!xrFrameTransforms.hasPreviousFrame) {
                prevModelMatrix.copy(object.matrixWorld);
                prevViewLeft.copy(camL.matrixWorldInverse);
                prevProjLeft.copy(camL.projectionMatrix);
                prevViewRight.copy(camR.matrixWorldInverse);
                prevProjRight.copy(camR.projectionMatrix);
            }

            material.uniforms.uProjLeft.value.copy(camL.projectionMatrix);
            material.uniforms.uViewModLeft.value.multiplyMatrices(camL.matrixWorldInverse, object.matrixWorld);
            material.uniforms.uProjRight.value.copy(camR.projectionMatrix);
            material.uniforms.uViewModRight.value.multiplyMatrices(camR.matrixWorldInverse, object.matrixWorld);

            material.uniforms.uPrevProjLeft.value.copy(prevProjLeft);
            material.uniforms.uPrevViewModLeft.value.multiplyMatrices(prevViewLeft, prevModelMatrix);
            material.uniforms.uPrevProjRight.value.copy(prevProjRight);
            material.uniforms.uPrevViewModRight.value.multiplyMatrices(prevViewRight, prevModelMatrix);
        };

        return material;
    }
});
