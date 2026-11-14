# ATHANOR backend.
#
# Compute runs out-of-process, one uv environment per scorer, because torch
# (MACE, fairchem) and tblite each link their own copy of libomp and abort the
# process when imported together — and fairchem additionally needs its own
# Python 3.11 + torch 2.4 pin. `make envs` builds all of them.

.PHONY: help envs env-server env-mace env-xtb env-fairchem check test lint fixture clean-envs

help:
	@echo "make envs     - build the server env and every scorer env (slow: downloads torch)"
	@echo "make check    - verify every env imports what it needs"
	@echo "make test     - run the test suite"
	@echo "make lint     - ruff"
	@echo "make fixture  - regenerate campaigns/fixture from real calculations"

envs: env-server env-mace env-xtb env-fairchem
	@echo "\nall environments built. run 'make check' to verify."

env-server:
	uv sync

# MACE-MP-0. CPU/float32: the MPS backend cannot take the float64 model.
env-mace:
	cd envs/mace && uv venv --python 3.12 -q && \
	uv pip install -q "mace-torch>=0.3.10" "ase>=3.23" "scipy<1.15"

# GFN2-xTB via tblite, plus RDKit for molecular work.
env-xtb:
	cd envs/xtb && uv venv --python 3.12 -q && \
	uv pip install -q "tblite>=0.4" "ase>=3.23" "rdkit>=2024.3" "scipy<1.15"

# Meta FAIR Open Catalyst / ODAC23. Needs Python 3.11 and torch 2.4;
# scipy is pinned because fairchem imports scipy.special.sph_harm,
# which was removed in scipy 1.17.
env-fairchem:
	cd envs/fairchem && uv venv --python 3.11 -q && \
	uv pip install -q "torch==2.4.1" "numpy<2" "scipy==1.14.1" && \
	uv pip install -q torch_geometric && \
	uv pip install -q "fairchem-core>=1.4,<2"

check:
	@uv run python -c "import fastapi, anthropic, ase, pymatgen, mp_api, rdkit; print('server env OK')"
	@envs/mace/.venv/bin/python -c "import torch, mace; print('mace env OK, torch', torch.__version__)"
	@envs/xtb/.venv/bin/python -c "import tblite.ase, rdkit; print('xtb env OK')"
	@envs/fairchem/.venv/bin/python -c "from fairchem.core import OCPCalculator; print('fairchem env OK')"
	@uv run python -c "import asyncio; from athanor.workers.base import run_worker; \
	print('worker roundtrip:', asyncio.run(run_worker('mace', {'op': 'ping'})))"

test:
	uv run pytest tests/ -q

lint:
	uv run ruff check athanor/ scripts/

fixture:
	uv run python scripts/make_fixture.py

clean-envs:
	rm -rf envs/*/.venv .venv
