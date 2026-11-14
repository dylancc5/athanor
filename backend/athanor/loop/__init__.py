"""The campaign loop: orchestrator, generator, router, seeds and notebook view.

Deliberately empty of imports. `agents.intake` needs the property vocabulary
from `loop.router`, while `loop.campaign` needs the agents — re-exporting either
here would close that circle at import time. Import the submodule you want:

    from athanor.loop.campaign import Campaign
    from athanor.loop.notebook import build_notebook
"""
