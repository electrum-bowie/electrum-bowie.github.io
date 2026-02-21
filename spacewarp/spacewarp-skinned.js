AFRAME.registerComponent('spacewarp-skinned', {
    schema: { meshName: { type: 'string', default: '' } },

    init: function () {
        this.sceneEl = this.el.sceneEl;
        this.motionMesh = null;
        this.sourceMesh = null;
        this.spaceWarp = null;
        this.hasPreviousFrame = false;

        this.prevBoneTexture = null;
        this.prevBoneMatrices = null;

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
        let best = null;
        let bestCount = -1;
        const meshName = this.data.meshName.trim().toLowerCase();

        root.traverse((node) => {
            if (node.isSkinnedMesh && node.skeleton && node.geometry && node.geometry.attributes && node.geometry.attributes.position) {
                if (meshName && !(node.name || '').toLowerCase().includes(meshName)) return;
                const count = node.geometry.attributes.position.count;
                if (count > bestCount) {
                    best = node;
                    bestCount = count;
                }
            }
        });
        return best;
    },

    initPrevBoneState: function () {
        const skeleton = this.sourceMesh.skeleton;
        if (!skeleton.boneTexture) skeleton.computeBoneTexture();
        skeleton.update();

        const size = skeleton.boneTexture.image.width;
        this.prevBoneMatrices = new Float32Array(size * size * 4);
        this.prevBoneMatrices.fill(0);
        this.prevBoneMatrices.set(skeleton.boneMatrices);

        this.prevBoneTexture = new THREE.DataTexture(this.prevBoneMatrices, size, size, THREE.RGBAFormat, THREE.FloatType);
        this.prevBoneTexture.needsUpdate = true;
        this.prevBoneTexture.magFilter = THREE.NearestFilter;
        this.prevBoneTexture.minFilter = THREE.NearestFilter;
        this.prevBoneTexture.generateMipmaps = false;
        this.prevBoneTexture.flipY = false;
    },

    cacheCurrentBonesAsPrevious: function () {
        if (!this.sourceMesh || !this.prevBoneTexture) return;
        this.prevBoneMatrices.set(this.sourceMesh.skeleton.boneMatrices);
        this.prevBoneTexture.needsUpdate = true;
    },

    destroyMotionMesh: function () {
        if (this.motionMesh && this.spaceWarp && this.spaceWarp.scene) {
            this.spaceWarp.scene.remove(this.motionMesh);
            this.motionMesh.material.dispose();
        }
        this.motionMesh = null;
        if (this.prevBoneTexture) {
            this.prevBoneTexture.dispose();
            this.prevBoneTexture = null;
        }
        this.prevBoneMatrices = null;
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
        this.sourceMesh.skeleton.update();
        this.motionMesh.matrixWorld.copy(this.sourceMesh.matrixWorld);
    },

    setup: function () {
        if (this.motionMesh || !this.isSpaceWarpActive()) return;

        const renderer = this.sceneEl.renderer;
        this.spaceWarp = renderer.xr.spaceWarp;
        if (!this.spaceWarp || !this.spaceWarp.scene) return;

        const root = this.el.getObject3D('mesh');
        if (!root) return;

        this.sourceMesh = this.selectSourceMesh(root);
        if (!this.sourceMesh) return;

        this.initPrevBoneState();
        const mat = this.createMaterial();
        mat.uniforms.uPrevBoneTexture.value = this.prevBoneTexture;

        this.motionMesh = new THREE.SkinnedMesh(this.sourceMesh.geometry, mat);
        this.motionMesh.bindMode = this.sourceMesh.bindMode;
        this.motionMesh.bind(this.sourceMesh.skeleton, this.sourceMesh.bindMatrix);
        this.motionMesh.bindMatrix.copy(this.sourceMesh.bindMatrix);
        this.motionMesh.bindMatrixInverse.copy(this.sourceMesh.bindMatrixInverse);

        this.motionMesh.matrixAutoUpdate = false;
        this.motionMesh.frustumCulled = false;
        this.motionMesh.renderOrder = 9999;

        const sourceMaterial = Array.isArray(this.sourceMesh.material) ? this.sourceMesh.material[0] : this.sourceMesh.material;
        this.motionMesh.material.side = sourceMaterial && sourceMaterial.side !== undefined ? sourceMaterial.side : THREE.FrontSide;

        this.motionMesh.onAfterRender = (renderer, scene, camera) => {
            const camL = camera.cameras[0];
            const camR = camera.cameras[1];
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
        if (!this.motionMesh || !this.sourceMesh) this.setup();
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
                uProjLeft: { value: new THREE.Matrix4() }, uViewModLeft: { value: new THREE.Matrix4() },
                uProjRight: { value: new THREE.Matrix4() }, uViewModRight: { value: new THREE.Matrix4() },
                uPrevProjLeft: { value: new THREE.Matrix4() }, uPrevViewModLeft: { value: new THREE.Matrix4() },
                uPrevProjRight: { value: new THREE.Matrix4() }, uPrevViewModRight: { value: new THREE.Matrix4() },
                uPrevBoneTexture: { value: null }
            },
            vertexShader: `
                ${THREE.ShaderChunk.common}
                ${THREE.ShaderChunk.skinning_pars_vertex}

                uniform mat4 uProjLeft; uniform mat4 uViewModLeft;
                uniform mat4 uPrevProjLeft; uniform mat4 uPrevViewModLeft;
                uniform mat4 uProjRight; uniform mat4 uViewModRight;
                uniform mat4 uPrevProjRight; uniform mat4 uPrevViewModRight;
                uniform highp sampler2D uPrevBoneTexture;

                mat4 getPrevBoneMatrix( const in float i ) {
                    int size = textureSize( uPrevBoneTexture, 0 ).x;
                    int j = int( i ) * 4;
                    int x = j % size;
                    int y = j / size;
                    vec4 v1 = texelFetch( uPrevBoneTexture, ivec2( x, y ), 0 );
                    vec4 v2 = texelFetch( uPrevBoneTexture, ivec2( x + 1, y ), 0 );
                    vec4 v3 = texelFetch( uPrevBoneTexture, ivec2( x + 2, y ), 0 );
                    vec4 v4 = texelFetch( uPrevBoneTexture, ivec2( x + 3, y ), 0 );
                    return mat4( v1, v2, v3, v4 );
                }

                out vec4 curPos; out vec4 prevPos;

                void main() {
                    vec4 local = vec4(position, 1.0);
                    vec4 prevLocal = local;

                    ${THREE.ShaderChunk.skinbase_vertex}

                    // Current Frame Skinning
                    vec4 skinVertex = bindMatrix * vec4( position, 1.0 );
                    vec4 skinned = vec4( 0.0 );
                    skinned += boneMatX * skinVertex * skinWeight.x;
                    skinned += boneMatY * skinVertex * skinWeight.y;
                    skinned += boneMatZ * skinVertex * skinWeight.z;
                    skinned += boneMatW * skinVertex * skinWeight.w;
                    local = vec4( ( bindMatrixInverse * skinned ).xyz, 1.0 );

                    // Previous Frame Skinning
                    vec4 prevSkinVertex = bindMatrix * vec4( position, 1.0 );
                    vec4 prevSkinned = vec4( 0.0 );
                    prevSkinned += getPrevBoneMatrix( skinIndex.x ) * prevSkinVertex * skinWeight.x;
                    prevSkinned += getPrevBoneMatrix( skinIndex.y ) * prevSkinVertex * skinWeight.y;
                    prevSkinned += getPrevBoneMatrix( skinIndex.z ) * prevSkinVertex * skinWeight.z;
                    prevSkinned += getPrevBoneMatrix( skinIndex.w ) * prevSkinVertex * skinWeight.w;
                    prevLocal = vec4( ( bindMatrixInverse * prevSkinned ).xyz, 1.0 );
                    
                    if (gl_ViewID_OVR == 0u) {
                        curPos = uProjLeft * uViewModLeft * local;
                        prevPos = uPrevProjLeft * uPrevViewModLeft * prevLocal;
                    } else {
                        curPos = uProjRight * uViewModRight * local;
                        prevPos = uPrevProjRight * uPrevViewModRight * prevLocal;
                    }
                    gl_Position = curPos;
                }
            `,
            fragmentShader: `
                precision highp float;
                in vec4 curPos; in vec4 prevPos;
                out highp vec4 outColor;
                void main() {
                    vec3 c = curPos.xyz / curPos.w;
                    vec3 p = prevPos.xyz / prevPos.w;
                    outColor = vec4(c - p, 0.0);
                }
            `,
            blending: THREE.NoBlending, side: THREE.FrontSide, depthWrite: true, depthTest: true
        });

        material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
            this.syncMotionFromSource();
            const camL = camera.cameras[0];
            const camR = camera.cameras[1];

            if (!this.hasPreviousFrame) {
                this.prevModelMatrix.copy(object.matrixWorld);
                this.prevViewLeft.copy(camL.matrixWorldInverse);
                this.prevProjLeft.copy(camL.projectionMatrix);
                this.prevViewRight.copy(camR.matrixWorldInverse);
                this.prevProjRight.copy(camR.projectionMatrix);
                this.cacheCurrentBonesAsPrevious();
            }

            material.uniforms.uProjLeft.value.copy(camL.projectionMatrix);
            material.uniforms.uViewModLeft.value.multiplyMatrices(camL.matrixWorldInverse, object.matrixWorld);
            material.uniforms.uProjRight.value.copy(camR.projectionMatrix);
            material.uniforms.uViewModRight.value.multiplyMatrices(camR.matrixWorldInverse, object.matrixWorld);

            material.uniforms.uPrevProjLeft.value.copy(this.prevProjLeft);
            material.uniforms.uPrevViewModLeft.value.multiplyMatrices(this.prevViewLeft, this.prevModelMatrix);
            material.uniforms.uPrevProjRight.value.copy(this.prevProjRight);
            material.uniforms.uPrevViewModRight.value.multiplyMatrices(this.prevViewRight, this.prevModelMatrix);

            this.cacheCurrentBonesAsPrevious();
        };

        return material;
    }
});