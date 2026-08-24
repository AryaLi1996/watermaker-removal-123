"""
Make the backend package importable when running pytest from the project root.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
