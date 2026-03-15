vertexShader: `
                precision highp usampler2D;

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

                in uint splatIndex;

                out vec4 curPos;
                out vec2 vQuadPos;
                out vec4 vColor;

                vec2 unpackInt16(uint value) {
                    int v0 = int(value) >> 16;
                    int v1 = int(value << 16) >> 16;
                    return vec2(float(v1), float(v0));
                }

                vec4 projectSplat(
                    mat4 proj,
                    mat4 viewMod,
                    mat3 viewRot,
                    vec4 centerAndScaleData,
                    uvec4 covAndColorData,
                    vec2 quadPos
                ) {
                    vec4 camspace = viewMod * vec4(centerAndScaleData.xyz, 1.0);
                    vec4 pos2d = proj * camspace;

                    float bounds = pos2d.w;
                    if (pos2d.z < -bounds || pos2d.x < -bounds || pos2d.x > bounds || pos2d.y < -bounds || pos2d.y > bounds) {
                        return vec4(0.0, 0.0, 2.0, 1.0);
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

                    float invZ = 1.0 / camspace.z;
                    float invZ2 = invZ * invZ;
                    float focal = (1.0 / max(uViewportInv.y, 1e-8)) * abs(proj[1][1]);

                    mat3 J = mat3(
                        focal * invZ, 0.0, -focal * camspace.x * invZ2,
                        0.0, -focal * invZ, focal * camspace.y * invZ2,
                        0.0, 0.0, 0.0
                    );

                    mat3 cov = transpose(viewRot * J) * Vrk * (viewRot * J);
                    vec2 vCenter = pos2d.xy / pos2d.w;

                    float diag1 = cov[0][0] + 0.3;
                    float offDiag = cov[0][1];
                    float diag2 = cov[1][1] + 0.3;

                    float mid = 0.5 * (diag1 + diag2);
                    float radius = length(vec2((diag1 - diag2) * 0.5, offDiag));

                    float lambda1 = mid + radius;
                    float lambda2 = max(mid - radius, 0.1);

                    vec2 diagVec = normalize(vec2(offDiag, lambda1 - diag1));
                    vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagVec;
                    vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagVec.y, -diagVec.x);

                    vec2 ndcXY = vCenter + (quadPos.x * v2 + quadPos.y * v1) * uViewportInv;
                    float ndcZ = pos2d.z / pos2d.w;
                    return vec4(ndcXY, ndcZ, 1.0);
                }

                void main() {
                    uint texWidth = uint(uTextureWidth);
                    ivec2 texPos = ivec2(int(splatIndex % texWidth), int(splatIndex / texWidth));
                    vec4 centerAndScaleData = texelFetch(centerAndScaleTexture, texPos, 0);
                    uvec4 covAndColorData = texelFetch(covAndColorTexture, texPos, 0);
                    vec2 quadPos = position.xy;

                    uint colorUint = covAndColorData.w;
                    vColor = vec4(
                        vec3(colorUint & 0xFFu, (colorUint >> 8) & 0xFFu, (colorUint >> 16) & 0xFFu),
                        float(colorUint >> 24)
                    ) * 0.003921569;

                    #ifdef IS_MULTIVIEW
                    if (gl_ViewID_OVR == 0u) {
                        curPos = projectSplat(uProjLeft, uViewModLeft, uViewRotLeft, centerAndScaleData, covAndColorData, quadPos);
                    } else {
                        curPos = projectSplat(uProjRight, uViewModRight, uViewRotRight, centerAndScaleData, covAndColorData, quadPos);
                    }
                    #else
                    curPos = projectSplat(uProjLeft, uViewModLeft, uViewRotLeft, centerAndScaleData, covAndColorData, quadPos);
                    #endif

                    vQuadPos = quadPos;
                    gl_Position = curPos;
                }
            `,
            fragmentShader: `
                precision highp float;

                in vec2 vQuadPos;
                in vec4 vColor;
                out highp vec4 outColor;

                void main() {
                    float len2 = dot(vQuadPos, vQuadPos);
                    if (len2 > 0.5) discard;

                    float B = exp(-len2) * vColor.a;
                    outColor = vec4(vColor.rgb, B);
                }
            `,
            blending: THREE.NoBlending,
            side: THREE.FrontSide,
            depthWrite: true,
            depthTest: true,
            transparent: false
        });
