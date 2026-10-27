(function (root) {
  'use strict';

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function inflateRaw(compressedBytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compressedBytes);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (typeof require === 'function') {
      const zlib = require('zlib');
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(compressedBytes.buffer, compressedBytes.byteOffset, compressedBytes.byteLength)));
    }
    throw new Error('Browser does not support DecompressionStream.');
  }

  async function deflateRaw(rawBytes) {
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(rawBytes);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (typeof require === 'function') {
      const zlib = require('zlib');
      return new Uint8Array(zlib.deflateRawSync(Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)));
    }
    throw new Error('Browser does not support CompressionStream.');
  }

  const textDecoder = new TextDecoder('utf-8');
  const textEncoder = new TextEncoder();

  function parseZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const len = bytes.length;

    if (len < 22 || view.getUint32(0, true) !== 0x04034b50) {
      throw new Error('File is not a valid .3mf ZIP archive.');
    }

    let eocdOffset = -1;
    const minEocd = Math.max(0, len - 65557);
    for (let i = len - 22; i >= minEocd; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Could not locate ZIP Central Directory in .3mf archive.');
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const entries = [];
    const byName = Object.create(null);
    let ptr = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
      if (ptr + 46 > len || view.getUint32(ptr, true) !== 0x02014b50) {
        throw new Error('Corrupted Central Directory entry in .3mf archive.');
      }
      const flags = view.getUint16(ptr + 8, true);
      const method = view.getUint16(ptr + 10, true);
      const dosTime = view.getUint16(ptr + 12, true);
      const dosDate = view.getUint16(ptr + 14, true);
      const crc = view.getUint32(ptr + 16, true);
      const compSize = view.getUint32(ptr + 20, true);
      const uncompSize = view.getUint32(ptr + 24, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localHeaderOffset = view.getUint32(ptr + 42, true);

      const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const name = textDecoder.decode(nameBytes);

      if (localHeaderOffset + 30 > len || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error('Invalid local file header for ' + name);
      }
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawCompressed = bytes.subarray(dataStart, dataStart + compSize);

      const entry = {
        name,
        flags,
        method,
        dosTime,
        dosDate,
        crc,
        compSize,
        uncompSize,
        rawCompressed,
        async getBytes() {
          if (this._decodedBytes) return this._decodedBytes;
          if (this.method === 0) {
            this._decodedBytes = this.rawCompressed;
          } else if (this.method === 8) {
            this._decodedBytes = await inflateRaw(this.rawCompressed);
          } else {
            throw new Error('Unsupported ZIP compression method ' + this.method + ' in ' + this.name);
          }
          return this._decodedBytes;
        },
        async getText() {
          const b = await this.getBytes();
          return textDecoder.decode(b);
        }
      };

      entries.push(entry);
      byName[name] = entry;
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    return { entries, byName, totalBytes: len };
  }

  async function buildZip(entrySpecs) {
    const prepared = [];
    let totalDataBytes = 0;
    let totalCdBytes = 0;

    for (const spec of entrySpecs) {
      const nameBytes = textEncoder.encode(spec.name);
      let method = spec.method;
      let crc = spec.crc;
      let uncompSize = spec.uncompSize;
      let compBytes = spec.rawCompressed;

      if (spec.newBytes) {
        const raw = spec.newBytes instanceof Uint8Array ? spec.newBytes : textEncoder.encode(String(spec.newBytes));
        uncompSize = raw.length;
        crc = crc32(raw);
        if (spec.storeOnly || raw.length < 64) {
          method = 0;
          compBytes = raw;
        } else {
          method = 8;
          compBytes = await deflateRaw(raw);
        }
      }

      const compSize = compBytes.length;
      const dosTime = spec.dosTime || 0x4800;
      const dosDate = spec.dosDate || 0x5B5B;

      prepared.push({
        nameBytes,
        method,
        dosTime,
        dosDate,
        crc,
        compSize,
        uncompSize,
        compBytes
      });

      totalDataBytes += 30 + nameBytes.length + compSize;
      totalCdBytes += 46 + nameBytes.length;
    }

    const out = new Uint8Array(totalDataBytes + totalCdBytes + 22);
    const view = new DataView(out.buffer);
    let offset = 0;

    for (const item of prepared) {
      item.localOffset = offset;
      view.setUint32(offset, 0x04034b50, true);
      view.setUint16(offset + 4, 20, true);
      view.setUint16(offset + 6, 0x0800, true);
      view.setUint16(offset + 8, item.method, true);
      view.setUint16(offset + 10, item.dosTime, true);
      view.setUint16(offset + 12, item.dosDate, true);
      view.setUint32(offset + 14, item.crc, true);
      view.setUint32(offset + 18, item.compSize, true);
      view.setUint32(offset + 22, item.uncompSize, true);
      view.setUint16(offset + 26, item.nameBytes.length, true);
      view.setUint16(offset + 28, 0, true);
      out.set(item.nameBytes, offset + 30);
      out.set(item.compBytes, offset + 30 + item.nameBytes.length);
      offset += 30 + item.nameBytes.length + item.compBytes.length;
    }

    const cdStart = offset;
    for (const item of prepared) {
      view.setUint32(offset, 0x02014b50, true);
      view.setUint16(offset + 4, 20, true);
      view.setUint16(offset + 6, 20, true);
      view.setUint16(offset + 8, 0x0800, true);
      view.setUint16(offset + 10, item.method, true);
      view.setUint16(offset + 12, item.dosTime, true);
      view.setUint16(offset + 14, item.dosDate, true);
      view.setUint32(offset + 16, item.crc, true);
      view.setUint32(offset + 20, item.compSize, true);
      view.setUint32(offset + 24, item.uncompSize, true);
      view.setUint16(offset + 28, item.nameBytes.length, true);
      view.setUint16(offset + 30, 0, true);
      view.setUint16(offset + 32, 0, true);
      view.setUint16(offset + 34, 0, true);
      view.setUint16(offset + 36, 0, true);
      view.setUint32(offset + 38, 0, true);
      view.setUint32(offset + 42, item.localOffset, true);
      out.set(item.nameBytes, offset + 46);
      offset += 46 + item.nameBytes.length;
    }

    const cdSize = offset - cdStart;
    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 4, 0, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, prepared.length, true);
    view.setUint16(offset + 10, prepared.length, true);
    view.setUint32(offset + 12, cdSize, true);
    view.setUint32(offset + 16, cdStart, true);
    view.setUint16(offset + 20, 0, true);

    return out;
  }

  // Speed and acceleration caps for Elegoo Centauri Carbon 2 (0.4mm nozzle, DL profile).
  const CC2_SPEED_LIMITS = {
    outer_wall_speed: { max: 120, unit: 'mm/s', label: 'Outer wall speed' },
    inner_wall_speed: { max: 200, unit: 'mm/s', label: 'Inner wall speed' },
    sparse_infill_speed: { max: 250, unit: 'mm/s', label: 'Sparse infill speed' },
    internal_solid_infill_speed: { max: 250, unit: 'mm/s', label: 'Internal solid infill speed' },
    top_surface_speed: { max: 200, unit: 'mm/s', label: 'Top surface speed' },
    gap_infill_speed: { max: 200, unit: 'mm/s', label: 'Gap infill speed' },
    support_speed: { max: 150, unit: 'mm/s', label: 'Support speed' },
    support_interface_speed: { max: 80, unit: 'mm/s', label: 'Support interface speed' },
    bridge_speed: { max: 35, unit: 'mm/s', label: 'Bridge speed' },
    travel_speed: { max: 400, unit: 'mm/s', label: 'Travel speed' },
    initial_layer_speed: { max: 50, unit: 'mm/s', label: 'First layer speed' },
    initial_layer_infill_speed: { max: 80, unit: 'mm/s', label: 'First layer infill speed' },
    ironing_speed: { max: 30, unit: 'mm/s', label: 'Ironing speed' },
    skirt_speed: { max: 50, unit: 'mm/s', label: 'Skirt speed' },
    default_acceleration: { max: 10000, unit: 'mm/s²', label: 'Normal printing acceleration' },
    outer_wall_acceleration: { max: 5000, unit: 'mm/s²', label: 'Outer wall acceleration' },
    inner_wall_acceleration: { max: 10000, unit: 'mm/s²', label: 'Inner wall acceleration' },
    top_surface_acceleration: { max: 2000, unit: 'mm/s²', label: 'Top surface acceleration' },
    initial_layer_acceleration: { max: 500, unit: 'mm/s²', label: 'First layer acceleration' },
    travel_acceleration: { max: 10000, unit: 'mm/s²', label: 'Travel acceleration' }
  };

  // Keys renamed between Bambu Studio 2.x and ElegooSlicer 1.5.3.5 (OrcaSlicer 2.4.2).
  const BAMBU_TO_ELEGOO_KEY_MAP = {
    initial_layer_flow_ratio: 'first_layer_flow_ratio',
    ironing_direction: 'ironing_angle',
    enable_support_ironing: 'support_ironing',
    role_base_wipe_speed: 'role_based_wipe_speed',
    sparse_infill_anchor: 'infill_anchor',
    sparse_infill_anchor_max: 'infill_anchor_max',
    sparse_infill_lattice_angle_1: 'lateral_lattice_angle_1',
    sparse_infill_lattice_angle_2: 'lateral_lattice_angle_2',
    prime_tower_extra_rib_length: 'wipe_tower_extra_rib_length',
    prime_tower_fillet_wall: 'wipe_tower_fillet_wall',
    prime_tower_rib_width: 'wipe_tower_rib_width',
    prime_tower_max_speed: 'wipe_tower_max_purge_speed',
    process_notes: 'notes'
  };

  // Author process settings carried over from source Bambu Studio project_settings.config.
  const AUTHOR_PROCESS_KEYS = [
    'layer_height',
    'initial_layer_print_height',
    'line_width',
    'outer_wall_line_width',
    'inner_wall_line_width',
    'sparse_infill_line_width',
    'internal_solid_infill_line_width',
    'top_surface_line_width',
    'support_line_width',
    'initial_layer_line_width',
    'wall_loops',
    'top_shell_layers',
    'top_shell_thickness',
    'bottom_shell_layers',
    'bottom_shell_thickness',
    'wall_sequence',
    'wall_generator',
    'wall_transition_length',
    'wall_transition_filter_margin',
    'wall_transition_angle',
    'min_feature_size',
    'min_bead_width',
    'only_one_wall_top',
    'only_one_wall_first_layer',
    'seam_position',
    'staggered_inner_seams',
    'seam_gap',
    'scarf_angle_threshold',
    'seam_slope_type',
    'seam_slope_conditional',
    'seam_slope_start_height',
    'seam_slope_entire_loop',
    'seam_slope_min_length',
    'seam_slope_steps',
    'seam_slope_inner_walls',
    'wipe_speed',
    'role_based_wipe_speed',
    'ironing_type',
    'ironing_pattern',
    'ironing_flow',
    'ironing_speed',
    'ironing_spacing',
    'ironing_inset',
    'ironing_angle',
    'xy_hole_compensation',
    'xy_contour_compensation',
    'elefant_foot_compensation',
    'precise_outer_wall',
    'precise_z_height',
    'sparse_infill_density',
    'sparse_infill_pattern',
    'top_surface_pattern',
    'bottom_surface_pattern',
    'internal_solid_infill_pattern',
    'infill_direction',
    'bridge_angle',
    'minimum_sparse_infill_area',
    'infill_combination',
    'infill_wall_overlap',
    'detect_narrow_internal_solid_infill',
    'ensure_vertical_shell_thickness',
    'skeleton_infill_density',
    'skin_infill_density',
    'enable_support',
    'support_type',
    'support_style',
    'support_threshold_angle',
    'support_on_build_plate_only',
    'support_critical_regions_only',
    'support_remove_small_overhang',
    'raft_layers',
    'raft_contact_distance',
    'raft_expansion',
    'raft_first_layer_density',
    'raft_first_layer_expansion',
    'support_filament',
    'support_interface_filament',
    'independent_support_layer_height',
    'support_top_z_distance',
    'support_bottom_z_distance',
    'support_object_xy_distance',
    'support_object_first_layer_gap',
    'support_base_pattern',
    'support_base_pattern_spacing',
    'support_angle',
    'support_expansion',
    'support_interface_top_layers',
    'support_interface_bottom_layers',
    'support_interface_pattern',
    'support_interface_spacing',
    'support_interface_loop_pattern',
    'bridge_no_support',
    'max_bridge_length',
    'thick_bridges',
    'tree_support_branch_angle',
    'tree_support_branch_angle_organic',
    'tree_support_branch_diameter',
    'tree_support_branch_diameter_angle',
    'tree_support_branch_diameter_double_wall',
    'tree_support_branch_diameter_organic',
    'tree_support_branch_distance',
    'tree_support_branch_distance_organic',
    'tree_support_brim_width',
    'tree_support_auto_brim',
    'tree_support_tip_diameter',
    'tree_support_top_rate',
    'tree_support_wall_count',
    'tree_support_with_infill',
    'brim_type',
    'brim_width',
    'brim_object_gap',
    'brim_ears_max_angle',
    'brim_ears_detection_length',
    'skirt_loops',
    'skirt_distance',
    'skirt_height',
    'enable_prime_tower',
    'prime_tower_width',
    'prime_tower_brim_width',
    'prime_volume',
    'wipe_tower_no_sparse_layers',
    'flush_into_infill',
    'flush_into_objects',
    'flush_into_support',
    'flush_multiplier',
    'fuzzy_skin',
    'fuzzy_skin_thickness',
    'fuzzy_skin_point_distance',
    'spiral_mode',
    'smooth_spiral_mode',
    'print_sequence',
    'slicing_mode',
    'slice_closing_radius',
    'resolution',
    'reduce_crossing_wall',
    'max_travel_detour_distance',
    'reduce_infill_retraction',
    'enable_overhang_speed',
    'overhang_1_4_speed',
    'overhang_2_4_speed',
    'overhang_3_4_speed',
    'overhang_4_4_speed',
    'small_perimeter_speed',
    'small_perimeter_threshold',
    'outer_wall_speed',
    'inner_wall_speed',
    'sparse_infill_speed',
    'internal_solid_infill_speed',
    'top_surface_speed',
    'gap_infill_speed',
    'support_speed',
    'support_interface_speed',
    'bridge_speed',
    'travel_speed',
    'initial_layer_speed',
    'initial_layer_infill_speed',
    'default_acceleration',
    'outer_wall_acceleration',
    'inner_wall_acceleration',
    'top_surface_acceleration',
    'initial_layer_acceleration',
    'travel_acceleration',
    'bridge_acceleration',
    'sparse_infill_acceleration',
    'internal_solid_infill_acceleration'
  ];

  // Bambu Studio 2.x per-object metadata keys not supported by ElegooSlicer 1.5.3.5.
  const UNSUPPORTED_MODEL_METADATA_KEYS = new Set([
    'enable_height_slowdown',
    'smooth_coefficient',
    'top_color_penetration_layers',
    'bottom_color_penetration_layers',
    'top_one_wall_type',
    'vertical_shell_speed'
  ]);

  function unwrapScalar(val) {
    if (Array.isArray(val)) {
      return val.length > 0 ? String(val[0]) : '';
    }
    if (val === null || val === undefined) return '';
    return String(val);
  }

  function translateEnumValue(key, rawVal) {
    const val = unwrapScalar(rawVal);
    if (key === 'support_style') {
      if (val === 'tree_organic') return { value: 'organic', note: 'Translated Bambu tree_organic to ElegooSlicer organic' };
      if (val === 'tree_default') return { value: 'default', note: 'Translated Bambu tree_default to default' };
    }
    if (key === 'tree_support_wall_count' && val === '-1') {
      return { value: '1', note: 'Translated Bambu auto (-1) tree wall count to 1' };
    }
    if (key === 'ensure_vertical_shell_thickness') {
      if (val === 'enabled' || val === '1') return { value: 'ensure_all', note: 'Translated enabled to ensure_all' };
      if (val === 'disabled' || val === '0') return { value: 'none', note: 'Translated disabled to none' };
    }
    if (key === 'fuzzy_skin' && val === 'none') {
      return { value: 'disabled_fuzzy', note: 'Translated none to disabled_fuzzy' };
    }
    if ((key === 'ironing_pattern' || key === 'support_ironing_pattern') && val === 'zig-zag') {
      return { value: 'rectilinear', note: 'Translated zig-zag ironing to rectilinear' };
    }
    if (key === 'internal_solid_infill_pattern' && val === 'zig-zag') {
      return { value: 'monotonic', note: 'Translated zig-zag solid infill to monotonic' };
    }
    if ((key === 'sparse_infill_pattern' || key === 'top_surface_pattern' || key === 'bottom_surface_pattern') && val === 'zig-zag') {
      return { value: 'zigzag', note: 'Translated zig-zag to zigzag' };
    }
    return { value: val, note: null };
  }

  function clampSpeedOrAccel(key, rawVal, customLimits) {
    const strVal = unwrapScalar(rawVal).trim();
    if (!strVal || strVal.endsWith('%')) {
      return { value: strVal, clamped: false, original: strVal };
    }
    const limits = (customLimits && customLimits[key]) || CC2_SPEED_LIMITS[key];
    if (!limits) {
      return { value: strVal, clamped: false, original: strVal };
    }
    const num = parseFloat(strVal);
    if (Number.isNaN(num)) {
      return { value: strVal, clamped: false, original: strVal };
    }
    if (num > limits.max) {
      return {
        value: String(limits.max),
        clamped: true,
        original: strVal,
        max: limits.max,
        unit: limits.unit,
        label: limits.label
      };
    }
    return { value: strVal, clamped: false, original: strVal, max: limits.max, unit: limits.unit, label: limits.label };
  }

  function parseBedSize(printableArea) {
    if (!Array.isArray(printableArea) || printableArea.length === 0) {
      return { width: 256, depth: 256 };
    }
    let maxX = 0;
    let maxY = 0;
    for (const pt of printableArea) {
      const parts = String(pt).split('x');
      if (parts.length === 2) {
        const x = parseFloat(parts[0]);
        const y = parseFloat(parts[1]);
        if (!Number.isNaN(x) && x > maxX) maxX = x;
        if (!Number.isNaN(y) && y > maxY) maxY = y;
      }
    }
    return {
      width: maxX > 0 ? maxX : 256,
      depth: maxY > 0 ? maxY : 256
    };
  }

  function parsePrusaSlicerIni(iniText) {
    const raw = Object.create(null);
    for (const line of iniText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      raw[k] = v;
    }

    const mapped = Object.create(null);
    if (raw.printer_model) mapped.printer_model = raw.printer_model;
    if (raw.printer_settings_id) mapped.printer_settings_id = raw.printer_settings_id;
    if (raw.print_settings_id) mapped.print_settings_id = raw.print_settings_id;
    if (raw.layer_height) mapped.layer_height = raw.layer_height;
    if (raw.first_layer_height) mapped.initial_layer_print_height = raw.first_layer_height.replace('%', '');
    if (raw.perimeters) mapped.wall_loops = raw.perimeters;
    if (raw.top_solid_layers) mapped.top_shell_layers = raw.top_solid_layers;
    if (raw.bottom_solid_layers) mapped.bottom_shell_layers = raw.bottom_solid_layers;
    if (raw.top_solid_min_thickness) mapped.top_shell_thickness = raw.top_solid_min_thickness;
    if (raw.bottom_solid_min_thickness) mapped.bottom_shell_thickness = raw.bottom_solid_min_thickness;
    if (raw.fill_density) mapped.sparse_infill_density = raw.fill_density;
    if (raw.fill_pattern) {
      const patMap = { stars: 'triangles', rectilinear: 'rectilinear', alignedrectilinear: 'alignedrectilinear', grid: 'grid', triangles: 'triangles', cubic: 'cubic', adaptivecubic: 'adaptivecubic', gyroid: 'gyroid', honeycomb: 'honeycomb', '3dhoneycomb': '3dhoneycomb', lightning: 'lightning', concentric: 'concentric' };
      mapped.sparse_infill_pattern = patMap[raw.fill_pattern] || 'gyroid';
    }
    if (raw.support_material === '1' || raw.support_material === 'true') {
      mapped.enable_support = '1';
      if (raw.support_material_style === 'organic') {
        mapped.support_type = 'tree(auto)';
        mapped.support_style = 'organic';
      } else if (raw.support_material_style === 'snug') {
        mapped.support_type = 'normal(auto)';
        mapped.support_style = 'snug';
      } else {
        mapped.support_type = 'normal(auto)';
        mapped.support_style = 'grid';
      }
    } else if (raw.support_material === '0') {
      mapped.enable_support = '0';
    }
    if (raw.support_material_buildplate_only) {
      mapped.support_on_build_plate_only = (raw.support_material_buildplate_only === '1' || raw.support_material_buildplate_only === 'true') ? '1' : '0';
    }
    if (raw.support_material_threshold) mapped.support_threshold_angle = raw.support_material_threshold;
    if (raw.support_material_contact_distance) mapped.support_top_z_distance = raw.support_material_contact_distance;
    if (raw.brim_width) {
      const bw = parseFloat(raw.brim_width);
      if (bw > 0) {
        mapped.brim_type = 'outer_only';
        mapped.brim_width = String(bw);
      } else {
        mapped.brim_type = 'no_brim';
      }
    }
    if (raw.seam_position) {
      mapped.seam_position = raw.seam_position === 'rear' ? 'back' : raw.seam_position;
    }
    if (raw.external_perimeter_speed && !raw.external_perimeter_speed.endsWith('%')) mapped.outer_wall_speed = raw.external_perimeter_speed;
    if (raw.perimeter_speed && !raw.perimeter_speed.endsWith('%')) mapped.inner_wall_speed = raw.perimeter_speed;
    if (raw.infill_speed && !raw.infill_speed.endsWith('%')) mapped.sparse_infill_speed = raw.infill_speed;
    if (raw.solid_infill_speed && !raw.solid_infill_speed.endsWith('%')) mapped.internal_solid_infill_speed = raw.solid_infill_speed;
    if (raw.top_solid_infill_speed && !raw.top_solid_infill_speed.endsWith('%')) mapped.top_surface_speed = raw.top_solid_infill_speed;
    if (raw.bridge_speed && !raw.bridge_speed.endsWith('%')) mapped.bridge_speed = raw.bridge_speed;
    if (raw.travel_speed && !raw.travel_speed.endsWith('%')) mapped.travel_speed = raw.travel_speed;
    if (raw.first_layer_speed && !raw.first_layer_speed.endsWith('%')) mapped.initial_layer_speed = raw.first_layer_speed;
    if (raw.spiral_vase === '1') mapped.spiral_mode = '1';
    if (raw.bed_shape) {
      const pts = raw.bed_shape.split(',');
      mapped.printable_area = pts;
    }
    if (raw.filament_type) mapped.filament_type = raw.filament_type.split(';');
    if (raw.filament_colour) mapped.filament_colour = raw.filament_colour.split(';');
    if (raw.temperature) mapped.nozzle_temperature = raw.temperature.split(',');
    if (raw.bed_temperature) mapped.hot_plate_temp = raw.bed_temperature.split(',');
    if (raw.nozzle_diameter) mapped.nozzle_diameter = raw.nozzle_diameter.split(',');

    const diffKeys = Object.keys(mapped).filter(k => AUTHOR_PROCESS_KEYS.includes(k));
    mapped.different_settings_to_system = [diffKeys.join(';'), '', ''];
    return mapped;
  }

  function extractModelHeaderAndBuild(modelEntryBytes) {
    // Only decode the first 16 KB and last 16 KB so 85 MB inline meshes never block the main thread.
    const headLen = Math.min(modelEntryBytes.length, 16384);
    const headText = textDecoder.decode(modelEntryBytes.subarray(0, headLen));
    const tailStart = Math.max(0, modelEntryBytes.length - 16384);
    const tailText = textDecoder.decode(modelEntryBytes.subarray(tailStart));

    const metadata = Object.create(null);
    const metaRegex = /<metadata\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/metadata>/g;
    let m;
    while ((m = metaRegex.exec(headText)) !== null) {
      metadata[m[1]] = m[2].trim();
    }
    while ((m = metaRegex.exec(tailText)) !== null) {
      if (!metadata[m[1]]) metadata[m[1]] = m[2].trim();
    }

    const buildItems = [];
    const buildMatch = tailText.match(/<build[^>]*>([\s\S]*?)<\/build>/);
    if (buildMatch) {
      const itemRegex = /<item\s+([^>]+?)\/?>/g;
      let im;
      while ((im = itemRegex.exec(buildMatch[1])) !== null) {
        const attrs = im[1];
        const objIdMatch = attrs.match(/objectid="([^"]+)"/);
        const tfMatch = attrs.match(/transform="([^"]+)"/);
        const printableMatch = attrs.match(/printable="([^"]+)"/);
        if (objIdMatch && tfMatch) {
          const nums = tfMatch[1].trim().split(/\s+/).map(Number);
          if (nums.length === 12) {
            buildItems.push({
              objectid: objIdMatch[1],
              transform: nums,
              tx: nums[9],
              ty: nums[10],
              tz: nums[11],
              printable: printableMatch ? printableMatch[1] : '1'
            });
          }
        }
      }
    }

    return { metadata, buildItems };
  }

  function parseModelSettingsXml(xmlText) {
    const objects = [];
    const plates = [];

    const objRegex = /<object\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g;
    let om;
    while ((om = objRegex.exec(xmlText)) !== null) {
      const objId = om[1];
      const inner = om[2];
      const firstPartIdx = inner.indexOf('<part');
      const objMetaZone = firstPartIdx !== -1 ? inner.slice(0, firstPartIdx) : inner;

      const meta = Object.create(null);
      const mRegex = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/?>/g;
      let mm;
      while ((mm = mRegex.exec(objMetaZone)) !== null) {
        meta[mm[1]] = mm[2];
      }

      const parts = [];
      const partRegex = /<part\s+id="([^"]+)"(?:\s+subtype="([^"]*)")?[^>]*>([\s\S]*?)<\/part>/g;
      let pm;
      while ((pm = partRegex.exec(inner)) !== null) {
        const partId = pm[1];
        const subtype = pm[2] || 'normal_part';
        const pInner = pm[3];
        const pMeta = Object.create(null);
        let pmm;
        while ((pmm = mRegex.exec(pInner)) !== null) {
          pMeta[pmm[1]] = pmm[2];
        }
        parts.push({ id: partId, subtype, metadata: pMeta });
      }

      objects.push({
        id: objId,
        name: meta.name || ('Object ' + objId),
        extruder: meta.extruder || '1',
        metadata: meta,
        parts
      });
    }

    const plateRegex = /<plate>([\s\S]*?)<\/plate>/g;
    let plm;
    while ((plm = plateRegex.exec(xmlText)) !== null) {
      const pInner = plm[1];
      const pMeta = Object.create(null);
      const mRegex = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/?>/g;
      let mm;
      while ((mm = mRegex.exec(pInner)) !== null) {
        if (!pMeta[mm[1]]) pMeta[mm[1]] = mm[2];
      }
      const instances = [];
      const instRegex = /<model_instance>([\s\S]*?)<\/model_instance>/g;
      let im;
      while ((im = instRegex.exec(pInner)) !== null) {
        const iMeta = Object.create(null);
        let imm;
        while ((imm = mRegex.exec(im[1])) !== null) {
          iMeta[imm[1]] = imm[2];
        }
        if (iMeta.object_id) instances.push(iMeta.object_id);
      }
      plates.push({
        id: pMeta.plater_id || String(plates.length + 1),
        name: pMeta.plater_name || '',
        filament_maps: pMeta.filament_maps || '1 1 1 1',
        instances
      });
    }

    return { objects, plates };
  }

  function detectOutliers(sourceProj, modelInfo, customGcodeXml, sourceFormat) {
    const outliers = [];

    const rawNozzle = sourceProj.nozzle_diameter;
    const nozzleDiam = Array.isArray(rawNozzle) ? parseFloat(rawNozzle[0]) : parseFloat(rawNozzle || '0.4');
    if (!Number.isNaN(nozzleDiam) && Math.abs(nozzleDiam - 0.4) > 0.01) {
      outliers.push({
        severity: 'high',
        category: 'Hardware',
        title: 'Source file uses a ' + nozzleDiam + 'mm nozzle',
        detail: 'Your Elegoo Centauri Carbon 2 profile uses a 0.4mm nozzle. Line widths and layer heights from a ' + nozzleDiam + 'mm nozzle profile may need verification.'
      });
    }

    const filTypes = Array.isArray(sourceProj.filament_type) ? sourceProj.filament_type : (sourceProj.filament_type ? [sourceProj.filament_type] : ['PLA']);
    const filColors = Array.isArray(sourceProj.filament_colour) ? sourceProj.filament_colour : (sourceProj.filament_colour ? [sourceProj.filament_colour] : ['#FFFFFF']);
    const filNames = Array.isArray(sourceProj.filament_settings_id) ? sourceProj.filament_settings_id : [];
    const slotCount = Math.max(filTypes.length, filColors.length, filNames.length);

    if (slotCount > 4) {
      outliers.push({
        severity: 'high',
        category: 'Multi-Spool',
        title: 'Source project defines ' + slotCount + ' filament slots (exceeds 4-spool switcher)',
        detail: 'Only the first 4 filament slots map directly to your 4-spool switching system. Objects assigned to slots 5+ are remapped to slot 4 unless reassigned.'
      });
    }

    const nozzleTemps = Array.isArray(sourceProj.nozzle_temperature) ? sourceProj.nozzle_temperature : [];
    const bedTemps = Array.isArray(sourceProj.textured_plate_temp) ? sourceProj.textured_plate_temp : (Array.isArray(sourceProj.hot_plate_temp) ? sourceProj.hot_plate_temp : []);
    const maxVols = Array.isArray(sourceProj.filament_max_volumetric_speed) ? sourceProj.filament_max_volumetric_speed : [];
    const flows = Array.isArray(sourceProj.filament_flow_ratio) ? sourceProj.filament_flow_ratio : [];
    const retracts = Array.isArray(sourceProj.filament_retraction_length) ? sourceProj.filament_retraction_length : [];
    const isSupport = Array.isArray(sourceProj.filament_is_support) ? sourceProj.filament_is_support : [];

    for (let i = 0; i < Math.min(slotCount, 8); i++) {
      const fType = String(filTypes[i] || 'PLA').toUpperCase();
      const fName = String(filNames[i] || ('Slot ' + (i + 1)));
      const nTemp = parseFloat(nozzleTemps[i]);
      const bTemp = parseFloat(bedTemps[i]);
      const mVol = parseFloat(maxVols[i]);
      const flow = parseFloat(flows[i]);
      const retr = parseFloat(retracts[i]);

      if (fType !== 'PLA' && fType !== 'PLA-CF') {
        outliers.push({
          severity: 'warn',
          category: 'Filament Slot ' + (i + 1),
          title: 'Slot ' + (i + 1) + ' material is ' + fType + ' (' + fName + ')',
          detail: 'By default your calibrated Elegoo PLA @ECC2 profile is kept so printer-specific settings are not overwritten. You can switch Slot ' + (i + 1) + ' to an Elegoo ' + fType + ' @ECC2 preset below if you are printing this in ' + fType + '.'
        });
      }

      if (isSupport[i] === '1' || /support/i.test(fName)) {
        outliers.push({
          severity: 'warn',
          category: 'Filament Slot ' + (i + 1),
          title: 'Dedicated support interface filament in Slot ' + (i + 1) + ' (' + fName + ')',
          detail: 'The author configured a breakaway/dissolvable support filament in Slot ' + (i + 1) + ' (support_interface_filament: ' + unwrapScalar(sourceProj.support_interface_filament) + ').'
        });
      }

      if (fType === 'PLA') {
        if (!Number.isNaN(nTemp) && (nTemp >= 235 || nTemp <= 195)) {
          outliers.push({
            severity: 'info',
            category: 'Filament Slot ' + (i + 1),
            title: 'Unusual PLA nozzle temperature on Slot ' + (i + 1) + ': ' + nTemp + '°C',
            detail: 'Author set ' + nTemp + '°C on ' + fName + ' (your Elegoo PLA @ECC2 - Calibrated preset uses 210°C).'
          });
        }
        if (!Number.isNaN(bTemp) && (bTemp >= 70 || (bTemp > 0 && bTemp <= 40))) {
          outliers.push({
            severity: 'info',
            category: 'Filament Slot ' + (i + 1),
            title: 'Author bed temperature on Slot ' + (i + 1) + ' is ' + bTemp + '°C',
            detail: 'Source bed type "' + unwrapScalar(sourceProj.curr_bed_type) + '" used ' + bTemp + '°C (your CC2 preset uses 45°C High Temp / 60°C Textured PEI).'
          });
        }
      }

      if (!Number.isNaN(mVol) && mVol > 0 && mVol <= 14) {
        outliers.push({
          severity: 'warn',
          category: 'Filament Slot ' + (i + 1),
          title: 'Low max volumetric speed on Slot ' + (i + 1) + ': ' + mVol + ' mm³/s',
          detail: 'Author restricted volumetric flow to ' + mVol + ' mm³/s (' + fName + ', often used for Silk PLA or TPU). Consider using Elegoo PLA Silk @ECC2 (16 mm³/s) or slowing print speeds.'
        });
      }

      if (!Number.isNaN(flow) && (flow < 0.92 || flow > 1.06)) {
        outliers.push({
          severity: 'info',
          category: 'Filament Slot ' + (i + 1),
          title: 'Custom filament flow ratio on Slot ' + (i + 1) + ': ' + flow,
          detail: 'Author used a non-standard filament flow ratio of ' + flow + ' (kept at your calibrated 1.03 for CC2).'
        });
      }

      if (!Number.isNaN(retr) && retr > 1.2) {
        outliers.push({
          severity: 'info',
          category: 'Filament Slot ' + (i + 1),
          title: 'Custom filament retraction length on Slot ' + (i + 1) + ': ' + retr + 'mm',
          detail: 'Author set a ' + retr + 'mm retraction override on ' + fName + ' (kept at your calibrated 0.4mm direct-drive CC2 setting).'
        });
      }
    }

    if (unwrapScalar(sourceProj.enable_support) === '1' && unwrapScalar(sourceProj.support_critical_regions_only) === '1') {
      outliers.push({
        severity: 'warn',
        category: 'Support Generation',
        title: 'Bambu "Support critical regions only" is enabled with supports',
        detail: 'In ElegooSlicer/OrcaSlicer, combining tree supports with "critical regions only" often prunes branches needed for textured overhangs (such as ears or horns). The converter unchecks this by default so all overhangs receive supports.'
      });
    }

    if (customGcodeXml && /M400\s+U1/i.test(customGcodeXml)) {
      const zMatches = [...customGcodeXml.matchAll(/top_z="([^"]+)"[^>]*gcode="[^"]*M400\s+U1[^"]*"/gi)];
      const heights = zMatches.map(m => parseFloat(m[1]).toFixed(2) + 'mm').join(', ');
      outliers.push({
        severity: 'warn',
        category: 'Custom Layer G-code',
        title: 'Bambu pause command (M400 U1) detected at Z = ' + (heights || 'custom layer'),
        detail: 'Bambu Lab uses M400 U1 for magnet/insert pauses, which Klipper ignores. The converter automatically translates M400 U1 to M600 so your Centauri Carbon 2 pauses properly.'
      });
    }

    const bedSize = parseBedSize(sourceProj.printable_area);
    if (bedSize.width !== 256 || bedSize.depth !== 256) {
      outliers.push({
        severity: 'info',
        category: 'Bed Geometry',
        title: 'Source bed size is ' + bedSize.width + 'x' + bedSize.depth + 'mm (' + (unwrapScalar(sourceProj.printer_model) || sourceFormat) + ')',
        detail: 'Build plate coordinates will be remapped and centered onto your 256x256mm Elegoo Centauri Carbon 2 build plate.'
      });
    }

    if (unwrapScalar(sourceProj.spiral_mode) === '1') {
      outliers.push({
        severity: 'info',
        category: 'Print Mode',
        title: 'Spiral Vase mode is enabled',
        detail: 'Author enabled continuous single-wall spiral vase printing (spiral_mode = 1). This setting is preserved.'
      });
    }
    if (unwrapScalar(sourceProj.print_sequence) === 'by object') {
      outliers.push({
        severity: 'warn',
        category: 'Print Sequence',
        title: 'Print sequence is set to "By Object"',
        detail: 'Author configured sequential per-object printing. Extruder clearance heights on the Centauri Carbon 2 (36mm to rod, 90mm to lid) are applied.'
      });
    }

    return outliers;
  }

  async function inspect3mf(arrayBuffer, filename) {
    const zip = parseZip(arrayBuffer);

    let sourceFormat = 'generic';
    let sourceProj = Object.create(null);

    if (zip.byName['Metadata/project_settings.config']) {
      sourceFormat = 'bambu';
      const txt = await zip.byName['Metadata/project_settings.config'].getText();
      sourceProj = JSON.parse(txt);

      // Merge Metadata/process_settings_1.config if present in Orca/Bambu exports.
      const proc1Entry = zip.byName['Metadata/process_settings_1.config'] || zip.byName['Metadata/print_setting_1.config'];
      if (proc1Entry) {
        try {
          const proc1 = JSON.parse(await proc1Entry.getText());
          for (const [k, v] of Object.entries(proc1)) {
            if (AUTHOR_PROCESS_KEYS.includes(k) && sourceProj[k] === undefined) {
              sourceProj[k] = v;
            }
          }
        } catch (e) {}
      }
    } else if (zip.byName['Metadata/Slic3r_PE.config'] || zip.byName['Metadata/PrusaSlicer.config']) {
      sourceFormat = 'prusaslicer';
      const cfgEntry = zip.byName['Metadata/Slic3r_PE.config'] || zip.byName['Metadata/PrusaSlicer.config'];
      sourceProj = parsePrusaSlicerIni(await cfgEntry.getText());
    }

    const modelEntry = zip.byName['3D/3dmodel.model'];
    if (!modelEntry) {
      throw new Error('Archive is missing 3D/3dmodel.model.');
    }

    const modelBytes = await modelEntry.getBytes();
    const { metadata: modelMeta, buildItems } = extractModelHeaderAndBuild(modelBytes);

    let modelSettingsXml = '';
    let parsedModelSettings = { objects: [], plates: [] };
    if (zip.byName['Metadata/model_settings.config']) {
      modelSettingsXml = await zip.byName['Metadata/model_settings.config'].getText();
      parsedModelSettings = parseModelSettingsXml(modelSettingsXml);
    }

    let customGcodeXml = '';
    if (zip.byName['Metadata/custom_gcode_per_layer.xml']) {
      customGcodeXml = await zip.byName['Metadata/custom_gcode_per_layer.xml'].getText();
    }

    const hasVariableLayerHeight = Boolean(zip.byName['Metadata/layer_heights_profile.txt']);
    const hasHeightRangeModifiers = Boolean(zip.byName['Metadata/layer_config_ranges.xml']);

    let thumbnailBytes = null;
    const thumbCandidates = [
      'Metadata/plate_1.png',
      'Auxiliaries/.thumbnails/thumbnail_3mf.png',
      'Auxiliaries/.thumbnails/thumbnail_middle.png',
      'Metadata/top_1.png'
    ];
    for (const cand of thumbCandidates) {
      if (zip.byName[cand]) {
        thumbnailBytes = await zip.byName[cand].getBytes();
        break;
      }
    }

    const bedSize = parseBedSize(sourceProj.printable_area);
    const filTypes = Array.isArray(sourceProj.filament_type) ? sourceProj.filament_type : (sourceProj.filament_type ? [sourceProj.filament_type] : ['PLA']);
    const filColors = Array.isArray(sourceProj.filament_colour) ? sourceProj.filament_colour : (sourceProj.filament_colour ? [sourceProj.filament_colour] : ['#FFFFFF']);
    const filMultiColors = Array.isArray(sourceProj.filament_multi_colour) ? sourceProj.filament_multi_colour : filColors;
    const filNames = Array.isArray(sourceProj.filament_settings_id) ? sourceProj.filament_settings_id : [];
    const nozzleTemps = Array.isArray(sourceProj.nozzle_temperature) ? sourceProj.nozzle_temperature : [];
    const bedTemps = Array.isArray(sourceProj.textured_plate_temp) ? sourceProj.textured_plate_temp : (Array.isArray(sourceProj.hot_plate_temp) ? sourceProj.hot_plate_temp : []);
    const maxVols = Array.isArray(sourceProj.filament_max_volumetric_speed) ? sourceProj.filament_max_volumetric_speed : [];

    const sourceSlotCount = Math.max(1, filTypes.length, filColors.length, filNames.length);
    const defaultPalette = ['#FFFFFF', '#000000', '#6F5034', '#FDB272'];
    const spools = [];
    for (let i = 0; i < 4; i++) {
      const activeInSource = i < sourceSlotCount;
      const rawType = activeInSource ? String(filTypes[i] || 'PLA').toUpperCase() : 'PLA';
      const color = (activeInSource && filColors[i]) ? filColors[i] : defaultPalette[i];
      const multiColor = (activeInSource && filMultiColors[i]) ? filMultiColors[i] : color;
      spools.push({
        slot: i + 1,
        activeInSource,
        sourceName: activeInSource ? (filNames[i] || ('Source ' + rawType)) : 'Unused Spool Slot',
        sourceType: rawType,
        color,
        multiColor,
        sourceNozzleTemp: activeInSource && nozzleTemps[i] ? nozzleTemps[i] + '°C' : '220°C',
        sourceBedTemp: activeInSource && bedTemps[i] ? bedTemps[i] + '°C' : '60°C',
        sourceMaxVol: activeInSource && maxVols[i] ? maxVols[i] + ' mm³/s' : '21 mm³/s',
        targetPreset: 'Elegoo PLA @ECC2 - Calibrated'
      });
    }

    const outliers = detectOutliers(sourceProj, parsedModelSettings, customGcodeXml, sourceFormat);

    // Collect per-object & modifier overrides for inspection
    const objectOverrides = [];
    for (const obj of parsedModelSettings.objects) {
      const oKeys = Object.keys(obj.metadata).filter(k => k !== 'name' && k !== 'extruder' && !k.startsWith('source_'));
      if (oKeys.length > 0) {
        objectOverrides.push({
          scope: 'Object: ' + obj.name + ' (Spool #' + obj.extruder + ')',
          settings: oKeys.map(k => ({ key: k, value: obj.metadata[k] }))
        });
      }
      for (const part of obj.parts) {
        const pKeys = Object.keys(part.metadata).filter(k => k !== 'name' && k !== 'matrix' && !k.startsWith('source_'));
        if (pKeys.length > 0 || part.subtype !== 'normal_part') {
          objectOverrides.push({
            scope: 'Part: ' + (part.metadata.name || part.id) + ' [' + part.subtype + ']',
            settings: pKeys.map(k => ({ key: k, value: part.metadata[k] }))
          });
        }
      }
    }

    return {
      filename: filename || 'model.3mf',
      totalBytes: zip.totalBytes,
      zip,
      sourceFormat,
      sourceProj,
      modelMeta,
      buildItems,
      bedSize,
      parsedModelSettings,
      modelSettingsXml,
      customGcodeXml,
      hasVariableLayerHeight,
      hasHeightRangeModifiers,
      thumbnailBytes,
      spools,
      sourceSlotCount,
      outliers,
      objectOverrides
    };
  }

  function buildTranslatedProjectSettings(inspected, options) {
    const opts = Object.assign({
      baseProcessPreset: '0.20mm Standard @Elegoo CC2 0.4 nozzle - DL profile',
      fixCriticalSupportRegions: true,
      infillPatternOverride: 'keep',
      brimOverride: 'keep',
      centerOnBed: inspected.bedSize.width !== 256 || inspected.bedSize.depth !== 256,
      spoolPresets: inspected.spools.map(s => s.targetPreset),
      spoolColors: inspected.spools.map(s => s.color)
    }, options || {});

    const base = JSON.parse(JSON.stringify(root.CC2_BASELINE));
    const sys020 = root.CC2_SYSTEM_020 || {};
    const src = inspected.sourceProj || {};

    // Apply selected base process preset if user chose Skadis 0.28mm or System 0.20mm
    if (opts.baseProcessPreset === '0.20mm Standard @Elegoo CC2 0.4 nozzle') {
      for (const [k, v] of Object.entries(sys020)) {
        base[k] = v;
      }
      base.print_settings_id = '0.20mm Standard @Elegoo CC2 0.4 nozzle';
      base.default_print_profile = '0.20mm Standard @Elegoo CC2 0.4 nozzle';
    } else if (opts.baseProcessPreset === '0.28mm Extra Draft @Elegoo CC2 0.4 nozzle - skadis' && root.CC2_SKADIS_028) {
      for (const [k, v] of Object.entries(root.CC2_SKADIS_028)) {
        if (k in base && k !== 'name' && k !== 'inherits' && k !== 'from' && k !== 'version') {
          base[k] = v;
        }
      }
      base.print_settings_id = '0.28mm Extra Draft @Elegoo CC2 0.4 nozzle - skadis';
      base.default_print_profile = '0.28mm Extra Draft @Elegoo CC2 0.4 nozzle';
    }

    const authorDiffRaw = (Array.isArray(src.different_settings_to_system) && src.different_settings_to_system[0])
      ? String(src.different_settings_to_system[0]).split(';').filter(Boolean)
      : [];
    const authorExplicitSet = new Set(authorDiffRaw.map(k => BAMBU_TO_ELEGOO_KEY_MAP[k] || k));

    const diffs = [];

    // First handle renamed Bambu Studio 2.x keys
    const normalizedSrc = Object.assign(Object.create(null), src);
    for (const [bambuKey, elegooKey] of Object.entries(BAMBU_TO_ELEGOO_KEY_MAP)) {
      if (src[bambuKey] !== undefined && normalizedSrc[elegooKey] === undefined) {
        normalizedSrc[elegooKey] = src[bambuKey];
      }
    }
    if (src.top_one_wall_type !== undefined && normalizedSrc.only_one_wall_top === undefined) {
      const tow = unwrapScalar(src.top_one_wall_type);
      normalizedSrc.only_one_wall_top = (tow === 'all top' || tow === 'topmost' || tow === '1') ? '1' : '0';
    }

    // Translate author process keys onto CC2 base
    for (const key of AUTHOR_PROCESS_KEYS) {
      if (normalizedSrc[key] === undefined || !(key in base)) continue;

      const rawAuthorVal = normalizedSrc[key];
      const wasArray = Array.isArray(rawAuthorVal) && !Array.isArray(base[key]);
      const enumRes = translateEnumValue(key, rawAuthorVal);
      const speedRes = clampSpeedOrAccel(key, enumRes.value);

      let finalVal = speedRes.value;
      const rules = [];
      if (authorExplicitSet.has(key)) {
        rules.push('Author explicit override');
      }
      if (wasArray) {
        rules.push('Unwrapped Bambu 2.x array');
      }
      if (enumRes.note) {
        rules.push(enumRes.note);
      }
      if (speedRes.clamped) {
        rules.push('Clamped to CC2 limit (' + speedRes.original + ' -> ' + speedRes.max + ' ' + speedRes.unit + ')');
      }

      if (key === 'support_critical_regions_only' && opts.fixCriticalSupportRegions && unwrapScalar(normalizedSrc.enable_support) === '1' && finalVal === '1') {
        finalVal = '0';
        rules.push('Unchecked so overhangs (ears/horns) receive tree branches in ElegooSlicer');
      }

      if (key === 'sparse_infill_pattern' && opts.infillPatternOverride !== 'keep') {
        finalVal = opts.infillPatternOverride;
        rules.push('User override (' + opts.infillPatternOverride + ')');
      }

      if (key === 'brim_type' && opts.brimOverride !== 'keep') {
        finalVal = opts.brimOverride;
        rules.push('User override (' + opts.brimOverride + ')');
      }

      const prevCc2Val = unwrapScalar(base[key]);
      const origDisplay = unwrapScalar(rawAuthorVal);

      base[key] = Array.isArray(base[key]) ? [finalVal] : finalVal;

      if (origDisplay !== finalVal || prevCc2Val !== finalVal || authorExplicitSet.has(key) || speedRes.clamped || enumRes.note) {
        diffs.push({
          key,
          sourceVal: origDisplay,
          cc2DefaultVal: prevCc2Val,
          convertedVal: finalVal,
          isAuthorExplicit: authorExplicitSet.has(key),
          isClamped: speedRes.clamped,
          isEnumTranslated: Boolean(enumRes.note),
          rule: rules.length > 0 ? rules.join(' + ') : 'Preserved author setting'
        });
      }
    }

    // Preserve 4-spool AMS flush volumes matrix and vector from MakerWorld
    if (Array.isArray(src.flush_volumes_matrix) && src.flush_volumes_matrix.length > 0) {
      const k = Math.round(Math.sqrt(src.flush_volumes_matrix.length));
      if (k === 4) {
        base.flush_volumes_matrix = src.flush_volumes_matrix.map(String);
      } else if (k >= 1 && k < 4) {
        const mat = base.flush_volumes_matrix.slice();
        for (let r = 0; r < k; r++) {
          for (let c = 0; c < k; c++) {
            mat[r * 4 + c] = String(src.flush_volumes_matrix[r * k + c]);
          }
        }
        base.flush_volumes_matrix = mat;
      }
    }
    if (Array.isArray(src.flush_volumes_vector) && src.flush_volumes_vector.length > 0) {
      const vec = base.flush_volumes_vector.slice();
      for (let i = 0; i < Math.min(8, src.flush_volumes_vector.length); i++) {
        vec[i] = String(src.flush_volumes_vector[i]);
      }
      base.flush_volumes_vector = vec;
    }

    // Apply 4-spool filament presets and author colors without overwriting CC2 filament calibration
    const filPresetsMap = root.CC2_FILAMENT_PRESETS || {};
    const filSettingsIds = [];
    const filInherits = [];
    const filDiffStrings = [];

    for (let i = 0; i < 4; i++) {
      const chosenName = opts.spoolPresets[i] || 'Elegoo PLA @ECC2 - Calibrated';
      const preset = filPresetsMap[chosenName] || filPresetsMap['Elegoo PLA @ECC2 - Calibrated'];
      filSettingsIds.push(chosenName);
      filInherits.push(preset ? preset.inherits : 'Elegoo PLA @ECC2');
      filDiffStrings.push(preset ? preset.diff_keys : 'filament_cost;filament_flow_ratio;filament_retraction_length;hot_plate_temp;hot_plate_temp_initial_layer');

      if (preset && preset.values) {
        for (const [fk, fv] of Object.entries(preset.values)) {
          if (Array.isArray(base[fk]) && base[fk].length >= 4) {
            base[fk][i] = String(fv);
          }
        }
      }
      const chosenColor = opts.spoolColors[i] || inspected.spools[i].color || '#FFFFFF';
      base.filament_colour[i] = chosenColor;
      base.filament_multi_colour[i] = chosenColor;
    }

    base.filament_settings_id = filSettingsIds;
    base.inherits_group = [
      base.default_print_profile || '0.20mm Standard @Elegoo CC2 0.4 nozzle',
      filInherits[0],
      filInherits[1],
      filInherits[2],
      filInherits[3],
      'Elegoo Centauri Carbon 2 0.4 nozzle'
    ];

    // Recompute different_settings_to_system[0] so ElegooSlicer keeps every overridden process setting
    const procDiffKeys = new Set(
      (base.different_settings_to_system && base.different_settings_to_system[0])
        ? base.different_settings_to_system[0].split(';').filter(Boolean)
        : []
    );
    for (const k of AUTHOR_PROCESS_KEYS) {
      if (k in sys020 && k in base) {
        if (unwrapScalar(base[k]) !== unwrapScalar(sys020[k])) {
          procDiffKeys.add(k);
        }
      }
      if (authorExplicitSet.has(k) && k in base) {
        procDiffKeys.add(k);
      }
    }

    const printerDiffStr = (base.different_settings_to_system && base.different_settings_to_system[5])
      ? base.different_settings_to_system[5]
      : 'machine_max_acceleration_extruding;machine_max_acceleration_x;machine_max_acceleration_y;machine_max_jerk_e;retract_lift_above;retract_restart_extra_toolchange;retraction_minimum_travel;wipe_distance;z_hop_types';

    base.different_settings_to_system = [
      Array.from(procDiffKeys).sort().join(';'),
      filDiffStrings[0],
      filDiffStrings[1],
      filDiffStrings[2],
      filDiffStrings[3],
      printerDiffStr
    ];

    return { projectSettings: base, diffs, options: opts };
  }

  function transformModelSettingsXml(xmlText, customLimits) {
    if (!xmlText) return '';
    let out = xmlText;

    // Remove unsupported Bambu Studio 2.x object metadata lines
    out = out.replace(/^[ \t]*<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>\r?\n?/gm, (fullMatch, key, val) => {
      if (UNSUPPORTED_MODEL_METADATA_KEYS.has(key)) {
        if (key === 'top_one_wall_type') {
          const mappedVal = (val === 'all top' || val === 'topmost' || val === '1') ? '1' : '0';
          return fullMatch.replace('key="top_one_wall_type"', 'key="only_one_wall_top"').replace('value="' + val + '"', 'value="' + mappedVal + '"');
        }
        return '';
      }
      if (key === 'extruder') {
        const extNum = parseInt(val, 10);
        if (!Number.isNaN(extNum) && extNum > 4) {
          return fullMatch.replace('value="' + val + '"', 'value="4"');
        }
      }
      const enumRes = translateEnumValue(key, val);
      const speedRes = clampSpeedOrAccel(key, enumRes.value, customLimits);
      if (speedRes.value !== val) {
        return fullMatch.replace('value="' + val + '"', 'value="' + speedRes.value + '"');
      }
      return fullMatch;
    });

    // Ensure filament_maps in <plate> has 4 slots for the 4-spool system
    out = out.replace(/<metadata\s+key="filament_maps"\s+value="([^"]*)"\s*\/>/g, (m, val) => {
      const parts = val.trim().split(/\s+/).filter(Boolean);
      while (parts.length < 4) parts.push('1');
      return '<metadata key="filament_maps" value="' + parts.slice(0, 4).join(' ') + '"/>';
    });

    return out;
  }

  function transformBuildCoordinatesInModelXml(modelBytes, oldWidth, oldDepth, forceCenter) {
    const tailSize = Math.min(modelBytes.length, 32768);
    const tailOffset = modelBytes.length - tailSize;
    const tailStr = textDecoder.decode(modelBytes.subarray(tailOffset));

    const buildMatch = tailStr.match(/<build[^>]*>([\s\S]*?)<\/build>/);
    if (!buildMatch) return { bytes: modelBytes, shifted: false, deltaX: 0, deltaY: 0 };

    const oldStrideX = oldWidth * 1.2;
    const oldStrideY = oldDepth * 1.2;
    const newStride = 256 * 1.2; // 307.2mm

    // First group items by plate (col, row) to compute per-plate centroid if forceCenter is enabled
    const itemRegex = /<item\s+([^>]+?)\/?>/g;
    const parsedItems = [];
    let im;
    while ((im = itemRegex.exec(buildMatch[1])) !== null) {
      const fullTag = im[0];
      const attrs = im[1];
      const tfMatch = attrs.match(/transform="([^"]+)"/);
      if (!tfMatch) continue;
      const nums = tfMatch[1].trim().split(/\s+/).map(Number);
      if (nums.length !== 12) continue;

      const tx = nums[9];
      const ty = nums[10];
      const col = Math.floor(tx / oldStrideX + 0.15);
      const row = Math.floor(-ty / oldStrideY + 0.15);
      const localX = tx - col * oldStrideX;
      const localY = ty + row * oldStrideY;
      parsedItems.push({ fullTag, tfStr: tfMatch[1], nums, col, row, localX, localY });
    }

    if (parsedItems.length === 0) {
      return { bytes: modelBytes, shifted: false, deltaX: 0, deltaY: 0 };
    }

    const byPlate = Object.create(null);
    for (const it of parsedItems) {
      const pk = it.col + ',' + it.row;
      if (!byPlate[pk]) byPlate[pk] = [];
      byPlate[pk].push(it);
    }

    let firstDeltaX = 0;
    let firstDeltaY = 0;
    let anyChanged = false;

    let newBuildInner = buildMatch[1];
    for (const [pk, plateItems] of Object.entries(byPlate)) {
      let shiftX = 128 - oldWidth / 2;
      let shiftY = 128 - oldDepth / 2;

      if (forceCenter) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const it of plateItems) {
          if (it.localX < minX) minX = it.localX;
          if (it.localX > maxX) maxX = it.localX;
          if (it.localY < minY) minY = it.localY;
          if (it.localY > maxY) maxY = it.localY;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        shiftX = 128 - cx;
        shiftY = 128 - cy;
      }

      if (pk === '0,0') {
        firstDeltaX = shiftX;
        firstDeltaY = shiftY;
      }

      for (const it of plateItems) {
        const newLocalX = Math.max(15, Math.min(241, it.localX + shiftX));
        const newLocalY = Math.max(15, Math.min(241, it.localY + shiftY));
        const newTx = it.col * newStride + newLocalX;
        const newTy = -it.row * newStride + newLocalY;

        if (Math.abs(newTx - it.nums[9]) > 0.05 || Math.abs(newTy - it.nums[10]) > 0.05) {
          anyChanged = true;
          const updatedNums = it.nums.slice();
          updatedNums[9] = Number(newTx.toFixed(4));
          updatedNums[10] = Number(newTy.toFixed(4));
          const newTf = 'transform="' + updatedNums.join(' ') + '"';
          const newTag = it.fullTag.replace('transform="' + it.tfStr + '"', newTf);
          newBuildInner = newBuildInner.replace(it.fullTag, newTag);
        }
      }
    }

    if (!anyChanged) {
      return { bytes: modelBytes, shifted: false, deltaX: 0, deltaY: 0 };
    }

    const updatedTailStr = tailStr.replace(buildMatch[0], buildMatch[0].replace(buildMatch[1], newBuildInner));
    const updatedTailBytes = textEncoder.encode(updatedTailStr);
    const merged = new Uint8Array(tailOffset + updatedTailBytes.length);
    merged.set(modelBytes.subarray(0, tailOffset), 0);
    merged.set(updatedTailBytes, tailOffset);

    return { bytes: merged, shifted: true, deltaX: firstDeltaX, deltaY: firstDeltaY };
  }

  async function convert3mf(inspected, options) {
    const { projectSettings, diffs, options: resolvedOpts } = buildTranslatedProjectSettings(inspected, options);

    const newSliceInfo = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '  <header>',
      '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
      '    <header_item key="X-BBL-Client-Version" value="01.05.03.05"/>',
      '    <header_item key="X-BBL-Client-Name" value="ElegooSlicer"/>',
      '    <header_item key="OrcaSlicer-Version" value="2.4.2"/>',
      '  </header>',
      '</config>',
      ''
    ].join('\n');

    const droppedFiles = new Set([
      'Metadata/Slic3r_PE.config',
      'Metadata/Slic3r_PE_model.config',
      'Metadata/PrusaSlicer.config'
    ]);

    const outSpecs = [];
    let hasProjectSettings = false;
    let hasSliceInfo = false;

    for (const entry of inspected.zip.entries) {
      if (droppedFiles.has(entry.name)) continue;
      if (/^Metadata\/(process_settings|print_setting|filament_settings|machine_settings)_\d+\.config$/.test(entry.name)) {
        continue;
      }

      if (entry.name === 'Metadata/project_settings.config') {
        hasProjectSettings = true;
        outSpecs.push({
          name: entry.name,
          newBytes: JSON.stringify(projectSettings, null, 4)
        });
        continue;
      }

      if (entry.name === 'Metadata/slice_info.config') {
        hasSliceInfo = true;
        outSpecs.push({
          name: entry.name,
          newBytes: newSliceInfo
        });
        continue;
      }

      if (entry.name === 'Metadata/model_settings.config') {
        const updatedModelXml = transformModelSettingsXml(inspected.modelSettingsXml);
        outSpecs.push({
          name: entry.name,
          newBytes: updatedModelXml
        });
        continue;
      }

      if (entry.name === 'Metadata/custom_gcode_per_layer.xml' && inspected.customGcodeXml) {
        const updatedGcodeXml = inspected.customGcodeXml.replace(/M400\s+U1/gi, 'M600');
        outSpecs.push({
          name: entry.name,
          newBytes: updatedGcodeXml
        });
        continue;
      }

      if (entry.name === '3D/3dmodel.model') {
        const needsBedRemap = resolvedOpts.centerOnBed || inspected.bedSize.width !== 256 || inspected.bedSize.depth !== 256;
        if (needsBedRemap) {
          const origBytes = await entry.getBytes();
          const remapped = transformBuildCoordinatesInModelXml(
            origBytes,
            inspected.bedSize.width,
            inspected.bedSize.depth,
            Boolean(resolvedOpts.centerOnBed)
          );
          if (remapped.shifted) {
            outSpecs.push({
              name: entry.name,
              newBytes: remapped.bytes
            });
            continue;
          }
        }
      }

      // Raw pass-through of pre-compressed bytes for untouched mesh and image entries
      outSpecs.push({
        name: entry.name,
        method: entry.method,
        dosTime: entry.dosTime,
        dosDate: entry.dosDate,
        crc: entry.crc,
        uncompSize: entry.uncompSize,
        rawCompressed: entry.rawCompressed
      });
    }

    if (!hasProjectSettings) {
      outSpecs.push({
        name: 'Metadata/project_settings.config',
        newBytes: JSON.stringify(projectSettings, null, 4)
      });
    }
    if (!hasSliceInfo) {
      outSpecs.push({
        name: 'Metadata/slice_info.config',
        newBytes: newSliceInfo
      });
    }

    const zipBytes = await buildZip(outSpecs);
    const baseName = inspected.filename.replace(/\.3mf$/i, '');
    const outFilename = baseName.endsWith('_CC2') ? (baseName + '.3mf') : (baseName + '_CC2.3mf');

    return {
      bytes: zipBytes,
      filename: outFilename,
      projectSettings,
      diffs
    };
  }

  async function buildSampleMakerWorld3mf() {
    const sample = root.CC2_SAMPLE_ARCHIVE;
    if (!sample) throw new Error('Sample archive metadata is not loaded.');

    const modelXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter" xml:lang="en-US" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
      ' <metadata name="Application">BambuStudio-02.06.00.51</metadata>',
      ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
      ' <metadata name="CreationDate">2026-04-27</metadata>',
      ' <metadata name="Designer">The Makers Edit</metadata>',
      ' <metadata name="ProfileTitle">0.2mm layer, 2 walls, 15% infill</metadata>',
      ' <metadata name="Title">Highland Cow Soap Holder BBW</metadata>',
      ' <resources>',
      '  <object id="1" type="model">',
      '   <mesh>',
      '    <vertices>',
      '     <vertex x="-45" y="-45" z="0" />',
      '     <vertex x="45" y="-45" z="0" />',
      '     <vertex x="45" y="45" z="0" />',
      '     <vertex x="-45" y="45" z="0" />',
      '     <vertex x="0" y="0" z="90" />',
      '    </vertices>',
      '    <triangles>',
      '     <triangle v1="0" v2="2" v3="1" paint_color="4" />',
      '     <triangle v1="0" v2="3" v3="2" paint_color="4" />',
      '     <triangle v1="0" v2="1" v3="4" paint_color="8" />',
      '     <triangle v1="1" v2="2" v3="4" paint_color="0C" />',
      '     <triangle v1="2" v2="3" v3="4" paint_color="8" />',
      '     <triangle v1="3" v2="0" v3="4" paint_color="4" />',
      '    </triangles>',
      '   </mesh>',
      '  </object>',
      '  <object id="2" type="model">',
      '   <components>',
      '    <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" />',
      '   </components>',
      '  </object>',
      ' </resources>',
      ' <build>',
      '  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 128.567445 102.615361 90.0655136" printable="1" />',
      ' </build>',
      '</model>'
    ].join('\n');

    const contentTypesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>';
    const relsXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

    const zipBytes = await buildZip([
      { name: '[Content_Types].xml', newBytes: contentTypesXml },
      { name: '_rels/.rels', newBytes: relsXml },
      { name: '3D/3dmodel.model', newBytes: modelXml },
      { name: 'Metadata/project_settings.config', newBytes: JSON.stringify(sample.project_settings, null, 4) },
      { name: 'Metadata/model_settings.config', newBytes: sample.model_settings },
      { name: 'Metadata/slice_info.config', newBytes: sample.slice_info },
      { name: 'Metadata/plate_1.json', newBytes: sample.plate_1 },
      { name: 'Metadata/filament_sequence.json', newBytes: sample.filament_sequence }
    ]);

    return {
      bytes: zipBytes,
      filename: sample.filename
    };
  }

  root.CC2Converter = {
    parseZip,
    buildZip,
    inspect3mf,
    buildTranslatedProjectSettings,
    convert3mf,
    buildSampleMakerWorld3mf,
    unwrapScalar,
    translateEnumValue,
    clampSpeedOrAccel,
    CC2_SPEED_LIMITS
  };
})(typeof window !== 'undefined' ? window : globalThis);
