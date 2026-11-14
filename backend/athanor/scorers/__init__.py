"""Scorers: candidates in, honest measurements out.

Deliberately empty of imports. Each scorer module pulls in a different heavy
dependency stack, and importing this package must never be the thing that
decides whether the server starts. Use `athanor.scorers.registry.all_scorers()`,
which tolerates a missing or broken scorer, or import a module directly.
"""
