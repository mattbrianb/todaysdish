"""Convert Real-ESRGAN realesr-general-x4v3.pth (SRVGGNetCompact) to ONNX without PyTorch.

The .pth is a zip holding a pickle plus raw tensor storages. A restricted unpickler only
allows the handful of names a plain state dict needs, so nothing in the file can run code.
"""
import pickle
import sys
import zipfile
from collections import OrderedDict

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

src, dst = sys.argv[1], sys.argv[2]
zf = zipfile.ZipFile(src)
names = zf.namelist()
root = names[0].split("/")[0]


class Storage:
    def __init__(self, key, dtype):
        self.key, self.dtype = key, dtype


class FloatStorage:
    pass


def rebuild_tensor_v2(storage, offset, size, stride, *_):
    raw = np.frombuffer(zf.read(f"{root}/data/{storage.key}"), dtype=storage.dtype)
    n = int(np.prod(size)) if size else 1
    arr = raw[offset:offset + n] if not size else np.lib.stride_tricks.as_strided(
        raw[offset:], shape=size, strides=[s * raw.itemsize for s in stride])
    return np.array(arr, dtype=np.float32)


class SafeUnpickler(pickle.Unpickler):
    ALLOWED = {("collections", "OrderedDict"): OrderedDict,
               ("torch._utils", "_rebuild_tensor_v2"): rebuild_tensor_v2,
               ("torch", "FloatStorage"): FloatStorage}

    def find_class(self, module, name):
        if (module, name) in self.ALLOWED:
            return self.ALLOWED[(module, name)]
        raise pickle.UnpicklingError(f"blocked {module}.{name}")

    def persistent_load(self, pid):
        # ('storage', storage_type, key, location, numel)
        return Storage(pid[2], np.float32)


state = SafeUnpickler(zf.open(f"{root}/data.pkl")).load()
if "params" in state:
    state = state["params"]
keys = list(state.keys())
print(len(keys), "tensors, e.g.", keys[:4], state[keys[0]].shape)

# SRVGGNetCompact: body = [conv, prelu, (conv, prelu) x num_conv, conv]; then pixel shuffle x4
# and the nearest-upsampled input added back.
nodes, inits = [], []
x = "input"
idx = sorted({int(k.split(".")[1]) for k in keys})
for i in idx:
    w = state.get(f"body.{i}.weight")
    b = state.get(f"body.{i}.bias")
    if b is not None:  # conv
        inits += [numpy_helper.from_array(w, f"w{i}"), numpy_helper.from_array(b, f"b{i}")]
        nodes.append(helper.make_node("Conv", [x, f"w{i}", f"b{i}"], [f"c{i}"], pads=[1, 1, 1, 1], kernel_shape=[3, 3]))
        x = f"c{i}"
    else:  # prelu, one slope per channel
        inits.append(numpy_helper.from_array(w.reshape(-1, 1, 1), f"a{i}"))
        nodes.append(helper.make_node("PRelu", [x, f"a{i}"], [f"p{i}"]))
        x = f"p{i}"
nodes.append(helper.make_node("DepthToSpace", [x], ["up"], blocksize=4, mode="CRD"))
inits.append(numpy_helper.from_array(np.array([1, 1, 4, 4], dtype=np.float32), "scales"))
inits.append(numpy_helper.from_array(np.array([], dtype=np.float32), "roi"))
nodes.append(helper.make_node("Resize", ["input", "roi", "scales"], ["base"], mode="nearest"))
nodes.append(helper.make_node("Add", ["up", "base"], ["output"]))
graph = helper.make_graph(
    nodes, "realesr-general-x4v3",
    [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, None, None])],
    [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, None, None])],
    inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, dst)
print("saved", dst)
