AFRAME.registerSystem('spacewarp-splats', {
    beforeMainRender: function (component, params) {
        if (!component || !params) return;

        const sourceMesh = params.sourceMesh || component.mesh || null;
        const xrFrameTransforms = this.getOrCreateXrFrameTransforms(component, sourceMesh);

        if (xrFrameTransforms.sourceMesh !== sourceMesh) {
            xrFrameTransforms.sourceMesh = sourceMesh || null;
            this.destroyMotionMesh(xrFrameTransforms);
        }

        if (!this.isSpaceWarpActive(component)) {
            this.destroyMotionMesh(xrFrameTransforms);
            return;
        }

        if (!sourceMesh || !params.projectionMatrix || !params.viewMatrix) return;

        this.updateFrameState(xrFrameTransforms, params);
        if (!xrFrameTransforms.motionMesh) {
            this.createMotionMesh(xrFrameTransforms);
        }
        this.attachMotionMeshToSpaceWarpScene(component, xrFrameTransforms);
    },

    dispose: function (component) {
        const xrFrameTransforms = component ? component._spaceWarpSplatsXrFrameTransforms || null : null;
        if (!xrFrameTransforms) return;

        this.destroyMotionMesh(xrFrameTransforms);
        delete component._spaceWarpSplatsXrFrameTransforms;
    },

    getOrCreateXrFrameTransforms: function (component, sourceMesh) {
        if (!component) return null;

        let xrFrameTransforms = component._spaceWarpSplatsXrFrameTransforms || null;
        if (!xrFrameTransforms) {
            xrFrameTransforms = this.createXrFrameTransforms(component, sourceMesh);
            component._spaceWarpSplatsXrFrameTransforms = xrFrameTransforms;
        } else if (sourceMesh !== undefined) {
            xrFrameTransforms.sourceMesh = sourceMesh || null;
        }

        return xrFrameTransforms;
    },

    updateFrameState: function (xrFrameTransforms, params) {
        const rightProjectionMatrix = params.rightProjectionMatrix || params.projectionMatrix;
        const rightViewMatrix = params.rightViewMatrix || params.viewMatrix;

        xrFrameTransforms.curProjLeft.copy(params.projectionMatrix);
        xrFrameTransforms.curViewLeft.copy(params.viewMatrix);
        xrFrameTransforms.curProjRight.copy(rightProjectionMatrix);
        xrFrameTransforms.curViewRight.copy(rightViewMatrix);
        xrFrameTransforms.viewport.set(Math.max(params.viewportWidth || 1, 1), Math.max(params.viewportHeight || 1, 1));

        if (!xrFrameTransforms.hasPrevious) {
            xrFrameTransforms.prevProjLeft.copy(xrFrameTransforms.curProjLeft);
            xrFrameTransforms.prevViewLeft.copy(xrFrameTransforms.curViewLeft);
            xrFrameTransforms.prevProjRight.copy(xrFrameTransforms.curProjRight);
            xrFrameTransforms.prevViewRight.copy(xrFrameTransforms.curViewRight);
            xrFrameTransforms.hasPrevious = true;
        }
    },

    createMotionMesh: function (xrFrameTransforms) {
        if (!xrFrameTransforms.sourceMesh || !xrFrameTransforms.sourceMesh.geometry) return;

        const sourceMaterial = this.getPrimaryMaterial(xrFrameTransforms.sourceMesh);
        if (!sourceMaterial || !sourceMaterial.uniforms) return;

        const spaceWarp = this.getSpaceWarp(xrFrameTransforms.component);
        if (!spaceWarp || !spaceWarp.scene) return;

        const motionMesh = new THREE.Mesh(xrFrameTransforms.sourceMesh.geometry, this.createMotionMaterial(xrFrameTransforms));
        motionMesh.matrixAutoUpdate = false;
        motionMesh.frustumCulled = false;
        motionMesh.renderOrder = 12000;

        motionMesh.onAfterRender = function () {
            xrFrameTransforms.prevProjLeft.copy(xrFrameTransforms.curProjLeft);
            xrFrameTransforms.prevViewLeft.copy(xrFrameTransforms.curViewLeft);
            xrFrameTransforms.prevProjRight.copy(xrFrameTransforms.curProjRight);
            xrFrameTransforms.prevViewRight.copy(xrFrameTransforms.curViewRight);
            xrFrameTransforms.hasPrevious = true;
        };

        xrFrameTransforms.motionMesh = motionMesh;
        this.syncMotionFromSource(xrFrameTransforms);
        spaceWarp.scene.add(motionMesh);
    },

    attachMotionMeshToSpaceWarpScene: function (component, xrFrameTransforms) {
        const spaceWarp = this.getSpaceWarp(component);
        if (!spaceWarp || !spaceWarp.scene || !xrFrameTransforms.motionMesh) return;

        if (xrFrameTransforms.motionMesh.parent !== spaceWarp.scene) {
            if (xrFrameTransforms.motionMesh.parent) {
                xrFrameTransforms.motionMesh.parent.remove(xrFrameTransforms.motionMesh);
            }
            spaceWarp.scene.add(xrFrameTransforms.motionMesh);
        }
    },

    createMotionMaterial: function (xrFrameTransforms) {
        const system = this;

        const material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: {
                centerAndScaleTexture: { value: null },
                covAndColorTexture: { value: null },
                uTextureWidth: { value: 1 },
                uViewportInv: { value: new THREE.Vector2(1, 1) },
                uFocalLeft: { value: 1.0 },
                uFocalRight: { value: 1.0 },

                uProjLeft: { value: new THREE.Matrix4() },
                uViewModLeft: { value: new THREE.Matrix4() },
                uProjRight: { value: new THREE.Matrix4() },
                uViewModRight: { value: new THREE.Matrix4() },

                uPrevProjLeft: { value: new THREE.Matrix4() },
                uPrevViewModLeft: { value: new THREE.Matrix4() },
                uPrevProjRight: { value: new THREE.Matrix4() },
                uPrevViewModRight: { value: new THREE.Matrix4() },

                uViewRotLeft: { value: new THREE.Matrix3() },
                uViewRotRight: { value: new THREE.Matrix3() },
                uPrevViewRotLeft: { value: new THREE.Matrix3() },
                uPrevViewRotRight: { value: new THREE.Matrix3() }
            },
vertexShader: `
                precision highp usampler2D;

                #define ALPHA_CUTOFF 0.15
                #define SPLAT_SCALE 0.33

                uniform sampler2D centerAndScaleTexture;
                uniform usampler2D covAndColorTexture;
                uniform int uTextureWidth;
                uniform vec2 uViewportInv;

                uniform mat4 uProjLeft;
                uniform mat4 uViewModLeft;
                uniform mat4 uProjRight;
                uniform mat4 uViewModRight;

                uniform mat4 uPrevProjLeft;
                uniform mat4 uPrevViewModLeft;
                uniform mat4 uPrevProjRight;
                uniform mat4 uPrevViewModRight;

                uniform mat3 uViewRotLeft;
                uniform mat3 uViewRotRight;
                uniform mat3 uPrevViewRotLeft;
                uniform mat3 uPrevViewRotRight;
                uniform float uFocalLeft;
                uniform float uFocalRight;

                in uint splatIndex;
                in float fadeOpacity;

                out vec3 vMotion;

                vec2 unpackInt16(uint value) {
                    int v0 = int(value) >> 16;
                    int v1 = int(value << 16) >> 16;
                    return vec2(float(v1), float(v0));
                }

                vec4 projectSplat(
                    vec4 camspace,
                    vec4 pos2d,
                    mat3 viewRot,
                    mat3 Vrk,
                    vec2 quadPos,
                    float focal
                ) {
                    float bounds = pos2d.w;
                    if (pos2d.z < -bounds || pos2d.x < -bounds || pos2d.x > bounds || pos2d.y < -bounds || pos2d.y > bounds) {
                        return vec4(0.0, 0.0, 2.0, 1.0);
                    }

                    float invZ = 1.0 / camspace.z;
                    float invZ2 = invZ * invZ;

                    mat3 J = mat3(
                        focal * invZ, 0.0, -focal * camspace.x * invZ2,
                        0.0, -focal * invZ, focal * camspace.y * invZ2,
                        0.0, 0.0, 0.0
                    );

                    mat3 A = viewRot * J;
                    vec3 A0 = A[0];
                    vec3 A1 = A[1];

                    vec3 VA0 = Vrk * A0;
                    vec3 VA1 = Vrk * A1;

                    float cov00 = dot(A0, VA0);
                    float cov01 = dot(A0, VA1);
                    float cov11 = dot(A1, VA1);

                    vec2 vCenter = pos2d.xy / pos2d.w;

                    float diag1 = cov00 + 0.3;
                    float offDiag = cov01;
                    float diag2 = cov11 + 0.3;

                    float mid = 0.5 * (diag1 + diag2);
                    float radius = length(vec2((diag1 - diag2) * 0.5, offDiag));

                    float lambda1 = mid + radius;
                    float lambda2 = max(mid - radius, 0.1);

                    vec2 diagVec = normalize(vec2(offDiag, lambda1 - diag1));
                    vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagVec * SPLAT_SCALE;
                    vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagVec.y, -diagVec.x) * SPLAT_SCALE;

                    vec2 ndcXY = vCenter + (quadPos.x * v2 + quadPos.y * v1) * uViewportInv;
                    float ndcZ = pos2d.z / pos2d.w;
                    return vec4(ndcXY, ndcZ, 1.0);
                }

                void main() {
                    uint texWidth = uint(uTextureWidth);
                    ivec2 texPos = ivec2(int(splatIndex % texWidth), int(splatIndex / texWidth));
                    vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);
                    vec2 quadPos = position.xy;
                    vec4 center = vec4(centerAndScaleData.xyz, 1.0);

                    mat4 curProj;
                    mat4 curViewMod;
                    mat3 curViewRot;
                    mat4 prevProj;
                    mat4 prevViewMod;
                    float curFocal;

                    if (gl_ViewID_OVR == 0u) {
                        curProj = uProjLeft;
                        curViewMod = uViewModLeft;
                        curViewRot = uViewRotLeft;
                        prevProj = uPrevProjLeft;
                        prevViewMod = uPrevViewModLeft;
                        curFocal = uFocalLeft;
                    } else {
                        curProj = uProjRight;
                        curViewMod = uViewModRight;
                        curViewRot = uViewRotRight;
                        prevProj = uPrevProjRight;
                        prevViewMod = uPrevViewModRight;
                        curFocal = uFocalRight;
                    }

                    vec4 curCamspace = curViewMod * center;
                    vec4 curPos2d = curProj * curCamspace;

                    float curBounds = curPos2d.w;
                    if (curPos2d.z < -curBounds || curPos2d.x < -curBounds || curPos2d.x > curBounds || curPos2d.y < -curBounds || curPos2d.y > curBounds) {
                        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                        vMotion = vec3(0.0);
                        return;
                    }

                    uvec4 covAndColorData = texelFetch(covAndColorTexture, texPos, 0);
                    float baseAlpha = float(covAndColorData.w >> 24) * 0.003921569;
                    if (baseAlpha * fadeOpacity < ALPHA_CUTOFF) {
                        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                        vMotion = vec3(0.0);
                        return;
                    }

                    float scale = centerAndScaleData.w;
                    vec2 cov3D_M11_M12 = unpackInt16(covAndColorData.x) * scale;
                    vec2 cov3D_M13_M22 = unpackInt16(covAndColorData.y) * scale;
                    vec2 cov3D_M23_M33 = unpackInt16(covAndColorData.z) * scale;

                    mat3 Vrk = mat3(
                        cov3D_M11_M12.x, cov3D_M11_M12.y, cov3D_M13_M22.x,
                        cov3D_M11_M12.y, cov3D_M13_M22.y, cov3D_M23_M33.x,
                        cov3D_M13_M22.x, cov3D_M23_M33.x, cov3D_M23_M33.y
                    );

                    vec4 prevCamspace = prevViewMod * center;
                    vec4 prevPos2d = prevProj * prevCamspace;

                    float invCurW = 1.0 / max(curPos2d.w, 1e-8);
                    float invPrevW = 1.0 / max(prevPos2d.w, 1e-8);
                    vec3 curCenterNdc = vec3(curPos2d.xy * invCurW, curPos2d.z * invCurW);
                    vec3 prevCenterNdc = vec3(prevPos2d.xy * invPrevW, prevPos2d.z * invPrevW);

                    vec4 curPos = projectSplat(curCamspace, curPos2d, curViewRot, Vrk, quadPos, curFocal);
                    vMotion = curCenterNdc - prevCenterNdc;
                    gl_Position = curPos;
                }
            `,
            fragmentShader: `
                precision highp float;

                in vec3 vMotion;
                out highp vec4 outColor;

                void main() {
                    outColor = vec4(vMotion, 0.0);
                }
            `,
            blending: THREE.NoBlending,
            side: THREE.FrontSide,
            depthWrite: true,
            depthTest: true,
            transparent: false
        });

        material.onBeforeRender = function () {
            const sourceMaterial = system.getPrimaryMaterial(xrFrameTransforms.sourceMesh);
            if (!sourceMaterial || !sourceMaterial.uniforms) return;

            system.syncMotionFromSource(xrFrameTransforms);

            const sourceUniforms = sourceMaterial.uniforms;
            material.uniforms.centerAndScaleTexture.value = sourceUniforms.centerAndScaleTexture ? sourceUniforms.centerAndScaleTexture.value : null;
            material.uniforms.covAndColorTexture.value = sourceUniforms.covAndColorTexture ? sourceUniforms.covAndColorTexture.value : null;
            material.uniforms.uTextureWidth.value = sourceUniforms.textureWidth ? sourceUniforms.textureWidth.value : 1;

            const viewportWidth = Math.max(xrFrameTransforms.viewport.x, 1);
            const viewportHeight = Math.max(xrFrameTransforms.viewport.y, 1);
            material.uniforms.uViewportInv.value.set(2.0 / viewportWidth, 2.0 / viewportHeight);
            const focalScale = viewportHeight * 0.5;

            material.uniforms.uProjLeft.value.copy(xrFrameTransforms.curProjLeft);
            material.uniforms.uViewModLeft.value.copy(xrFrameTransforms.curViewLeft);
            material.uniforms.uProjRight.value.copy(xrFrameTransforms.curProjRight);
            material.uniforms.uViewModRight.value.copy(xrFrameTransforms.curViewRight);

            material.uniforms.uPrevProjLeft.value.copy(xrFrameTransforms.prevProjLeft);
            material.uniforms.uPrevViewModLeft.value.copy(xrFrameTransforms.prevViewLeft);
            material.uniforms.uPrevProjRight.value.copy(xrFrameTransforms.prevProjRight);
            material.uniforms.uPrevViewModRight.value.copy(xrFrameTransforms.prevViewRight);
            material.uniforms.uFocalLeft.value = focalScale * Math.abs(xrFrameTransforms.curProjLeft.elements[5]);
            material.uniforms.uFocalRight.value = focalScale * Math.abs(xrFrameTransforms.curProjRight.elements[5]);

            xrFrameTransforms.viewRotLeft.setFromMatrix4(xrFrameTransforms.curViewLeft).transpose();
            xrFrameTransforms.viewRotRight.setFromMatrix4(xrFrameTransforms.curViewRight).transpose();
            xrFrameTransforms.prevViewRotLeft.setFromMatrix4(xrFrameTransforms.prevViewLeft).transpose();
            xrFrameTransforms.prevViewRotRight.setFromMatrix4(xrFrameTransforms.prevViewRight).transpose();

            material.uniforms.uViewRotLeft.value.copy(xrFrameTransforms.viewRotLeft);
            material.uniforms.uViewRotRight.value.copy(xrFrameTransforms.viewRotRight);
            material.uniforms.uPrevViewRotLeft.value.copy(xrFrameTransforms.prevViewRotLeft);
            material.uniforms.uPrevViewRotRight.value.copy(xrFrameTransforms.prevViewRotRight);

            material.side = sourceMaterial.side !== undefined ? sourceMaterial.side : THREE.FrontSide;
        };

        return material;
    },

    syncMotionFromSource: function (xrFrameTransforms) {
        if (!xrFrameTransforms.motionMesh || !xrFrameTransforms.sourceMesh) return;

        if (xrFrameTransforms.sourceMesh.updateWorldMatrix) {
            xrFrameTransforms.sourceMesh.updateWorldMatrix(true, false);
        } else {
            xrFrameTransforms.sourceMesh.updateMatrixWorld(true);
        }

        xrFrameTransforms.motionMesh.matrixWorld.copy(xrFrameTransforms.sourceMesh.matrixWorld);
    },

    destroyMotionMesh: function (xrFrameTransforms) {
        if (!xrFrameTransforms || !xrFrameTransforms.motionMesh) return;

        if (xrFrameTransforms.motionMesh.parent) {
            xrFrameTransforms.motionMesh.parent.remove(xrFrameTransforms.motionMesh);
        }

        if (xrFrameTransforms.motionMesh.material) {
            xrFrameTransforms.motionMesh.material.dispose();
        }

        xrFrameTransforms.motionMesh.onAfterRender = null;
        xrFrameTransforms.motionMesh = null;
    },

    isSpaceWarpActive: function (component) {
        const sceneEl = component && component.el ? component.el.sceneEl : null;
        if (!sceneEl || !sceneEl.renderer) return false;

        const renderer = sceneEl.renderer;
        const xr = renderer.xr;
        return !!(renderer.spaceWarp === true && xr && xr.isPresenting && xr.isSpaceWarp === true && xr.spaceWarp);
    },

    getSpaceWarp: function (component) {
        const sceneEl = component && component.el ? component.el.sceneEl : null;
        if (!sceneEl || !sceneEl.renderer || !sceneEl.renderer.xr) return null;

        const spaceWarp = sceneEl.renderer.xr.spaceWarp;
        if (!spaceWarp || !spaceWarp.scene) return null;

        return spaceWarp;
    },

    getPrimaryMaterial: function (mesh) {
        if (!mesh || !mesh.material) return null;
        return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    },

    createXrFrameTransforms: function (component, sourceMesh) {
        return {
            component,
            sourceMesh: sourceMesh || null,
            motionMesh: null,
            viewport: new THREE.Vector2(1, 1),
            curProjLeft: new THREE.Matrix4(),
            curViewLeft: new THREE.Matrix4(),
            curProjRight: new THREE.Matrix4(),
            curViewRight: new THREE.Matrix4(),
            prevProjLeft: new THREE.Matrix4(),
            prevViewLeft: new THREE.Matrix4(),
            prevProjRight: new THREE.Matrix4(),
            prevViewRight: new THREE.Matrix4(),
            hasPrevious: false,
            viewRotLeft: new THREE.Matrix3(),
            viewRotRight: new THREE.Matrix3(),
            prevViewRotLeft: new THREE.Matrix3(),
            prevViewRotRight: new THREE.Matrix3()
        };
    }
});
