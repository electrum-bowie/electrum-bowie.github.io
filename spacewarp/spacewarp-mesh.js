AFRAME.registerComponent('spacewarp-mesh', {
    schema: {
        meshName: { type: 'string', default: '' }
    },

    init: function () {
        this.sceneEl = this.el.sceneEl;
        this.motionMesh = null;
        this.sourceMesh = null;
        this.spaceWarp = null;
        this.hasPreviousFrame = false;

        this.prevModelMatrix = new THREE.Matrix4();
        this.prevViewLeft = new THREE.Matrix4();
        this.prevProjLeft = new THREE.Matrix4();
        this.prevViewRight = new THREE.Matrix4();
        this.prevProjRight = new THREE.Matrix4();

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

    selectSourceMesh: function (root) {
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

        if (meshes.length === 0) return null;

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

        const meshName = this.data.meshName.trim().toLowerCase();
        if (meshName) {
            const named = meshes.filter((m) => (m.name || '').toLowerCase().includes(meshName));
            if (named.length > 0) return pickLargest(named);
        }

        return pickLargest(meshes);
    },

    destroyMotionMesh: function () {
        if (this.motionMesh && this.spaceWarp && this.spaceWarp.scene) {
            this.spaceWarp.scene.remove(this.motionMesh);
            this.motionMesh.material.dispose();
        }

        this.motionMesh = null;
        this.sourceMesh = null;
        this.hasPreviousFrame = false;
    },

    syncMotionFromSource: function () {
        if (!this.motionMesh || !this.sourceMesh) return;

        if (this.el.object3D.updateWorldMatrix) {
            this.el.object3D.updateWorldMatrix(true, true);
        } else {
            this.el.object3D.updateMatrixWorld(true);
        }

        this.motionMesh.matrixWorld.copy(this.sourceMesh.matrixWorld);
    },

    setup: function () {
        if (this.motionMesh) return;
        if (!this.isSpaceWarpActive()) return;

        const renderer = this.sceneEl.renderer;
        this.spaceWarp = renderer.xr.spaceWarp;
        if (!this.spaceWarp || !this.spaceWarp.scene) return;

        const root = this.el.getObject3D('mesh');
        if (!root) return;

        this.sourceMesh = this.selectSourceMesh(root);
        if (!this.sourceMesh) return;

        const sourceMaterial = Array.isArray(this.sourceMesh.material) ? this.sourceMesh.material[0] : this.sourceMesh.material;
        const material = this.createMaterial();

        this.motionMesh = new THREE.Mesh(this.sourceMesh.geometry, material);
        this.motionMesh.matrixAutoUpdate = false;
        this.motionMesh.frustumCulled = false;
        this.motionMesh.renderOrder = 9999;
        this.motionMesh.material.side = sourceMaterial && sourceMaterial.side !== undefined ? sourceMaterial.side : THREE.FrontSide;

        this.motionMesh.onAfterRender = (renderer, scene, camera) => {
            const camL = camera.cameras && camera.cameras[0];
            const camR = camera.cameras && camera.cameras[1];
            if (!camL || !camR) return;

            this.prevModelMatrix.copy(this.motionMesh.matrixWorld);
            this.prevViewLeft.copy(camL.matrixWorldInverse);
            this.prevProjLeft.copy(camL.projectionMatrix);
            this.prevViewRight.copy(camR.matrixWorldInverse);
            this.prevProjRight.copy(camR.projectionMatrix);
            this.hasPreviousFrame = true;
        };

        this.spaceWarp.scene.add(this.motionMesh);
        this.syncMotionFromSource();
    },

    tick: function () {
        if (!this.isSpaceWarpActive()) {
            if (this.motionMesh) this.destroyMotionMesh();
            return;
        }

        if (!this.motionMesh || !this.sourceMesh) {
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
        this.destroyMotionMesh();
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
            this.syncMotionFromSource();

            const camL = camera.cameras && camera.cameras[0];
            const camR = camera.cameras && camera.cameras[1];
            if (!camL || !camR) return;

            if (!this.hasPreviousFrame) {
                this.prevModelMatrix.copy(object.matrixWorld);
                this.prevViewLeft.copy(camL.matrixWorldInverse);
                this.prevProjLeft.copy(camL.projectionMatrix);
                this.prevViewRight.copy(camR.matrixWorldInverse);
                this.prevProjRight.copy(camR.projectionMatrix);
            }

            material.uniforms.uProjLeft.value.copy(camL.projectionMatrix);
            material.uniforms.uViewModLeft.value.multiplyMatrices(camL.matrixWorldInverse, object.matrixWorld);
            material.uniforms.uProjRight.value.copy(camR.projectionMatrix);
            material.uniforms.uViewModRight.value.multiplyMatrices(camR.matrixWorldInverse, object.matrixWorld);

            material.uniforms.uPrevProjLeft.value.copy(this.prevProjLeft);
            material.uniforms.uPrevViewModLeft.value.multiplyMatrices(this.prevViewLeft, this.prevModelMatrix);
            material.uniforms.uPrevProjRight.value.copy(this.prevProjRight);
            material.uniforms.uPrevViewModRight.value.multiplyMatrices(this.prevViewRight, this.prevModelMatrix);
        };

        return material;
    }
});
