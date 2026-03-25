import React, { useEffect, useRef } from 'react';

/**
 * Configuration for the fluid simulation based on the provided JSON settings.
 * This object controls the behavior, quality, and appearance of the fluid.
 */
const config = {
  simulation_settings: {
    quality: "high",
    sim_resolution: 256,
    density_diffusion: 2.5, // Used to calculate how fast colors fade
    velocity_diffusion: 1.5, // Used to calculate how fast movement slows down
    pressure: 0.8, // Internal fluid pressure
    vorticity: 2, // Strength of swirling effects
    splat_radius: 0.25, // Size of the initial color splash
    shading: false, // Whether to apply lighting effects (currently disabled)
    colorful: true, // Whether to cycle through rainbow colors
    paused: false // Whether the simulation is currently running
  },
  bloom: {
    enabled: false,
    intensity: 0.0,
    threshold: 0.0
  },
  sunrays: {
    enabled: false,
    weight: 0.0
  },
  capture: {
    background_color: { r: 255, g: 255, b: 255 },
    transparent: true
  }
};

// Derived constants for internal simulation use
const DENSITY_DISSIPATION = 1.0 - (config.simulation_settings.density_diffusion / 100.0);
const VELOCITY_DISSIPATION = 1.0 - (config.simulation_settings.velocity_diffusion / 100.0);
const PRESSURE_ITERATIONS = 20; // Number of passes to solve fluid pressure
const COLOR_UPDATE_SPEED = 10; // Speed of the rainbow color cycle

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef({ h: 0 }); // Stores current hue for rainbow effect

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Initialize WebGL2 context
    // alpha: true allows the background to show through the fluid
    const gl = canvas.getContext('webgl2', { 
      alpha: config.capture.transparent, 
      depth: false, 
      stencil: false, 
      antialias: false 
    });
    if (!gl) return;

    // Enable floating point textures for high-precision simulation
    gl.getExtension('EXT_color_buffer_float');
    
    const simRes = config.simulation_settings.sim_resolution;
    const dyeRes = 512; // Resolution for the visible color/dye

    /**
     * Base Vertex Shader: Handles the positioning of the simulation grid.
     */
    const baseVertexShader = `
      precision highp float;
      attribute vec2 aPosition;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform vec2 texelSize;
      void main () {
          vUv = aPosition * 0.5 + 0.5;
          vL = vUv - vec2(texelSize.x, 0.0);
          vR = vUv + vec2(texelSize.x, 0.0);
          vT = vUv + vec2(0.0, texelSize.y);
          vB = vUv - vec2(0.0, texelSize.y);
          gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    /**
     * Clear Shader: Resets a texture to a specific value.
     */
    const clearShader = `
      precision mediump float;
      varying highp vec2 vUv;
      uniform sampler2D uTexture;
      uniform float value;
      void main () {
          gl_FragColor = value * texture2D(uTexture, vUv);
      }
    `;

    /**
     * Display Shader: Renders the final fluid colors to the screen.
     * It uses the brightness of the color to determine transparency.
     */
    const displayShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      void main () {
          vec3 c = texture2D(uTexture, vUv).rgb;
          float a = max(c.r, max(c.g, c.b));
          gl_FragColor = vec4(c, a);
      }
    `;

    /**
     * Splat Shader: Creates a "splash" of color or velocity at a specific point.
     */
    const splatShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspect, radius;
      uniform vec3 color;
      uniform vec2 point;
      void main () {
          vec2 p = vUv - point.xy;
          p.x *= aspect;
          vec3 base = texture2D(uTarget, vUv).xyz;
          vec3 splat = exp(-dot(p, p) / radius) * color;
          gl_FragColor = vec4(base + splat, 1.0);
      }
    `;

    /**
     * Advection Shader: Moves the fluid (and color) based on the current velocity.
     */
    const advectionShader = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity, uSource;
      uniform vec2 texelSize, dyeTexelSize;
      uniform float dt, dissipation;
      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
          vec2 st = uv / tsize - 0.5;
          vec2 iuv = floor(st);
          vec2 fuv = fract(st);
          vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
          vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
          vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
          vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
          return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
      }
      void main () {
          vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
          gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize);
          gl_FragColor.a = 1.0;
      }
    `;

    /**
     * Divergence Shader: Calculates how much the fluid is expanding or contracting at each point.
     */
    const divergenceShader = `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity;
      void main () {
          float L = texture2D(uVelocity, vL).x;
          float R = texture2D(uVelocity, vR).x;
          float T = texture2D(uVelocity, vT).y;
          float B = texture2D(uVelocity, vB).y;
          vec2 C = texture2D(uVelocity, vUv).xy;
          if (vL.x < 0.0) L = -C.x;
          if (vR.x > 1.0) R = -C.x;
          if (vT.y > 1.0) T = -C.y;
          if (vB.y < 0.0) B = -C.y;
          gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }
    `;

    /**
     * Curl Shader: Calculates the "swirliness" (vorticity) of the fluid.
     */
    const curlShader = `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity;
      void main () {
          float L = texture2D(uVelocity, vL).y;
          float R = texture2D(uVelocity, vR).y;
          float T = texture2D(uVelocity, vT).x;
          float B = texture2D(uVelocity, vB).x;
          float vorticity = R - L - T + B;
          gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
      }
    `;

    /**
     * Vorticity Shader: Applies forces to maintain and enhance small swirls in the fluid.
     */
    const vorticityShader = `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity, uCurl;
      uniform float curl, dt;
      void main () {
          float L = texture2D(uCurl, vL).x;
          float R = texture2D(uCurl, vR).x;
          float T = texture2D(uCurl, vT).x;
          float B = texture2D(uCurl, vB).x;
          float C = texture2D(uCurl, vUv).x;
          vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(L) - abs(R));
          force /= length(force) + 0.0001;
          force *= curl * C;
          vec2 velocity = texture2D(uVelocity, vUv).xy;
          gl_FragColor = vec4(velocity + force * dt, 0.0, 1.0);
      }
    `;

    /**
     * Pressure Shader: Solves the pressure field to keep the fluid incompressible.
     */
    const pressureShader = `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uDivergence;
      void main () {
          float L = texture2D(uPressure, vL).x;
          float R = texture2D(uPressure, vR).x;
          float T = texture2D(uPressure, vT).y;
          float B = texture2D(uPressure, vB).y;
          float div = texture2D(uDivergence, vUv).x;
          gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
      }
    `;

    /**
     * Gradient Subtract Shader: Updates the velocity field by subtracting the pressure gradient.
     */
    const gradientSubtractShader = `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uVelocity;
      void main () {
          float L = texture2D(uPressure, vL).x;
          float R = texture2D(uPressure, vR).x;
          float T = texture2D(uPressure, vT).y;
          float B = texture2D(uPressure, vB).y;
          vec2 velocity = texture2D(uVelocity, vUv).xy;
          velocity.x -= 0.5 * (R - L);
          velocity.y -= 0.5 * (T - B);
          gl_FragColor = vec4(velocity, 0.0, 1.0);
      }
    `;

    /**
     * Helper to create and compile a WebGL shader.
     */
    function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    }

    /**
     * Class to manage WebGL programs and their uniforms.
     */
    class Program {
      program: WebGLProgram;
      uniforms: { [key: string]: WebGLUniformLocation } = {};
      constructor(gl: WebGL2RenderingContext, vs: string, fs: string) {
        this.program = gl.createProgram()!;
        gl.attachShader(this.program, createShader(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(this.program, createShader(gl, gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(this.program);
        const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(this.program, i)!;
          this.uniforms[info.name] = gl.getUniformLocation(this.program, info.name)!;
        }
      }
      bind() { gl.useProgram(this.program); }
    }

    /**
     * Helper to create a Framebuffer Object (FBO) for off-screen rendering.
     */
    function createFBO(gl: WebGL2RenderingContext, w: number, h: number, internalFormat: number, format: number, type: number, param: number) {
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, fbo, attach: (id: number) => { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; } };
    }

    /**
     * Helper to create a double-buffered FBO for iterative calculations.
     */
    function createDoubleFBO(gl: WebGL2RenderingContext, w: number, h: number, internalFormat: number, format: number, type: number, param: number) {
      let f1 = createFBO(gl, w, h, internalFormat, format, type, param);
      let f2 = createFBO(gl, w, h, internalFormat, format, type, param);
      return { get read() { return f1; }, get write() { return f2; }, swap: () => { [f1, f2] = [f2, f1]; } };
    }

    // Initialize all simulation programs
    const clearProg = new Program(gl, baseVertexShader, clearShader);
    const displayProg = new Program(gl, baseVertexShader, displayShader);
    const splatProg = new Program(gl, baseVertexShader, splatShader);
    const advectionProg = new Program(gl, baseVertexShader, advectionShader);
    const divergenceProg = new Program(gl, baseVertexShader, divergenceShader);
    const curlProg = new Program(gl, baseVertexShader, curlShader);
    const vorticityProg = new Program(gl, baseVertexShader, vorticityShader);
    const pressureProg = new Program(gl, baseVertexShader, pressureShader);
    const gradSubProg = new Program(gl, baseVertexShader, gradientSubtractShader);

    let dye: any, velocity: any, divergence: any, curl: any, pressure: any;

    /**
     * Initializes the textures used for the simulation.
     */
    function initFramebuffers() {
      const texType = gl.HALF_FLOAT;
      dye = createDoubleFBO(gl, dyeRes, dyeRes, gl.RGBA16F, gl.RGBA, texType, gl.LINEAR);
      velocity = createDoubleFBO(gl, simRes, simRes, gl.RG16F, gl.RG, texType, gl.LINEAR);
      divergence = createFBO(gl, simRes, simRes, gl.R16F, gl.RED, texType, gl.NEAREST);
      curl = createFBO(gl, simRes, simRes, gl.R16F, gl.RED, texType, gl.NEAREST);
      pressure = createDoubleFBO(gl, simRes, simRes, gl.R16F, gl.RED, texType, gl.NEAREST);
    }
    initFramebuffers();

    /**
     * Renders a full-screen quad to trigger the fragment shader for each pixel.
     */
    const blit = (() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);
      return (dest: WebGLFramebuffer | null) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dest); gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0); };
    })();

    const pointer = { x: 0, y: 0, dx: 0, dy: 0, moved: false };

    /**
     * Main animation loop.
     */
    const update = () => {
      if (config.simulation_settings.paused) {
        requestAnimationFrame(update);
        return;
      }

      // Handle canvas resizing
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; initFramebuffers();
      }

      // Update rainbow color
      if (config.simulation_settings.colorful) {
        colorRef.current.h += 0.001 * COLOR_UPDATE_SPEED;
        if (colorRef.current.h > 1) colorRef.current.h = 0;
      }

      // Apply interaction splats
      if (pointer.moved) {
        const c = HSVtoRGB(colorRef.current.h, 1, 1);
        splat(pointer.x, pointer.y, pointer.dx, pointer.dy, [c.r * 10, c.g * 10, c.b * 10]);
        pointer.moved = false;
      }

      // Run simulation step
      step(0.016);

      // Render to screen
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      displayProg.bind();
      gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
      blit(null);

      requestAnimationFrame(update);
    };

    /**
     * Performs one physics step of the fluid simulation.
     */
    function step(dt: number) {
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, simRes, simRes);
      
      // 1. Advection: Move velocity field
      advectionProg.bind();
      gl.uniform2f(advectionProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform2f(advectionProg.uniforms.dyeTexelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(advectionProg.uniforms.uSource, velocity.read.attach(1));
      gl.uniform1f(advectionProg.uniforms.dt, dt);
      gl.uniform1f(advectionProg.uniforms.dissipation, VELOCITY_DISSIPATION);
      blit(velocity.write.fbo); velocity.swap();

      // 2. Advection: Move color (dye) field
      gl.viewport(0, 0, dyeRes, dyeRes);
      gl.uniform2f(advectionProg.uniforms.dyeTexelSize, 1 / dyeRes, 1 / dyeRes);
      gl.uniform1i(advectionProg.uniforms.uSource, dye.read.attach(1));
      gl.uniform1f(advectionProg.uniforms.dissipation, DENSITY_DISSIPATION);
      blit(dye.write.fbo); dye.swap();

      // 3. Vorticity Confinement: Enhance swirls
      gl.viewport(0, 0, simRes, simRes);
      curlProg.bind();
      gl.uniform2f(curlProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
      blit(curl.fbo);

      vorticityProg.bind();
      gl.uniform2f(vorticityProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(vorticityProg.uniforms.uCurl, curl.attach(1));
      gl.uniform1f(vorticityProg.uniforms.curl, config.simulation_settings.vorticity);
      gl.uniform1f(vorticityProg.uniforms.dt, dt);
      blit(velocity.write.fbo); velocity.swap();

      // 4. Divergence: Calculate expansion/contraction
      divergenceProg.bind();
      gl.uniform2f(divergenceProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
      blit(divergence.fbo);

      // 5. Pressure: Solve for pressure field
      clearProg.bind();
      gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
      gl.uniform1f(clearProg.uniforms.value, config.simulation_settings.pressure);
      blit(pressure.write.fbo); pressure.swap();

      pressureProg.bind();
      gl.uniform2f(pressureProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write.fbo); pressure.swap();
      }

      // 6. Gradient Subtract: Finalize velocity update
      gradSubProg.bind();
      gl.uniform2f(gradSubProg.uniforms.texelSize, 1 / simRes, 1 / simRes);
      gl.uniform1i(gradSubProg.uniforms.uPressure, pressure.read.attach(0));
      gl.uniform1i(gradSubProg.uniforms.uVelocity, velocity.read.attach(1));
      blit(velocity.write.fbo); velocity.swap();
    }

    /**
     * Creates a splat of velocity and color at the given coordinates.
     */
    function splat(x: number, y: number, dx: number, dy: number, color: number[]) {
      gl.viewport(0, 0, simRes, simRes);
      splatProg.bind();
      gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
      gl.uniform1f(splatProg.uniforms.aspect, canvas.width / canvas.height);
      gl.uniform2f(splatProg.uniforms.point, x / canvas.width, 1 - y / canvas.height);
      gl.uniform3f(splatProg.uniforms.color, dx, -dy, 1);
      gl.uniform1f(splatProg.uniforms.radius, config.simulation_settings.splat_radius / 100);
      blit(velocity.write.fbo); velocity.swap();

      gl.viewport(0, 0, dyeRes, dyeRes);
      gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(splatProg.uniforms.color, color[0], color[1], color[2]);
      blit(dye.write.fbo); dye.swap();
    }

    /**
     * Converts HSV color values to RGB.
     */
    function HSVtoRGB(h: number, s: number, v: number) {
      let i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
      switch (i % 6) {
        case 0: return { r: v, g: t, b: p };
        case 1: return { r: q, g: v, b: p };
        case 2: return { r: p, g: v, b: t };
        case 3: return { r: p, g: q, b: v };
        case 4: return { r: t, g: p, b: v };
        default: return { r: v, g: p, b: q };
      }
    }

    let first = true;
    const onMove = (e: MouseEvent) => {
      if (first) { first = false; pointer.x = e.offsetX; pointer.y = e.offsetY; }
      pointer.moved = true;
      pointer.dx = (e.offsetX - pointer.x) * 5;
      pointer.dy = (e.offsetY - pointer.y) * 5;
      pointer.x = e.offsetX; pointer.y = e.offsetY;
    };
    const onDown = (e: MouseEvent) => {
      const c = HSVtoRGB(colorRef.current.h, 1, 1);
      splat(e.offsetX, e.offsetY, 0, 0, [c.r * 10, c.g * 10, c.b * 10]);
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    update();
    return () => { 
      canvas.removeEventListener('mousemove', onMove); 
      canvas.removeEventListener('mousedown', onDown); 
    };
  }, []);

  const bgColor = config.capture.background_color;
  const bgStyle = `rgb(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`;

  return (
    <div 
      className="relative min-h-screen w-full overflow-hidden" 
      style={{ backgroundColor: bgStyle }}
    >
      <canvas 
        ref={canvasRef} 
        className="fixed inset-0 w-full h-full pointer-events-auto z-0" 
        style={{ background: config.capture.transparent ? 'transparent' : bgStyle }} 
      />
    </div>
  );
}
